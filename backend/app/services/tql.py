"""TQL — a JQL-style query language.

    project = APP AND status IN ("In Progress", "In Review") AND sprint = activeSprint()
    assignee = currentUser() AND due < "-3d" ORDER BY priority DESC, rank

Pipeline: lexer → recursive-descent parser → AST → compiler to SQLAlchemy expressions.
Only whitelisted fields reach SQL, and every value is a bound parameter.
"""

import re
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import Select, and_, cast, false, func, not_, or_, select
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.models import Issue, Project, Sprint, User, WorkflowStatus
from app.services.search import SORTS

MAX_DEPTH = 20
MAX_LEN = 4000

# ---------- lexer ----------

TOKEN_RE = re.compile(r"""
    \s*(?:
      (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
     |(?P<op>!=|>=|<=|!~|=|>|<|~|\(|\)|,)
     |(?P<word>[A-Za-z0-9_.\-@:]+)
    )""", re.VERBOSE)
KEYWORDS = {"AND", "OR", "NOT", "IN", "IS", "EMPTY", "NULL", "ORDER", "BY", "ASC", "DESC"}


@dataclass
class Tok:
    kind: str  # str | op | word | kw | eof
    value: str
    pos: int


def tokenize(q: str) -> list[Tok]:
    toks, pos = [], 0
    while pos < len(q):
        if q[pos:].strip() == "":
            break
        m = TOKEN_RE.match(q, pos)
        if not m or m.end() == pos:
            raise TQLError(f"Unexpected character at position {pos}: {q[pos]!r}")
        if m.group("str"):
            raw = m.group("str")[1:-1]
            toks.append(Tok("str", re.sub(r"\\(.)", r"\1", raw), m.start("str")))
        elif m.group("op"):
            toks.append(Tok("op", m.group("op"), m.start("op")))
        else:
            w = m.group("word")
            toks.append(Tok("kw" if w.upper() in KEYWORDS else "word", w.upper() if w.upper() in KEYWORDS else w, m.start("word")))
        pos = m.end()
    toks.append(Tok("eof", "", len(q)))
    return toks


# ---------- AST ----------


@dataclass(frozen=True)
class Func:
    name: str
    args: tuple


@dataclass(frozen=True)
class Clause:
    field: str
    op: str  # = != > >= < <= in not_in is_empty is_not_empty ~ !~
    values: tuple


@dataclass(frozen=True)
class BoolOp:
    op: str  # and | or
    left: Any
    right: Any


@dataclass(frozen=True)
class Not:
    node: Any


@dataclass(frozen=True)
class Query:
    where: Any
    order: tuple


class TQLError(HTTPException):
    def __init__(self, msg: str):
        super().__init__(422, f"TQL: {msg}")


# ---------- parser ----------


class Parser:
    def __init__(self, toks: list[Tok]):
        self.toks, self.i, self.depth = toks, 0, 0

    @property
    def cur(self) -> Tok:
        return self.toks[self.i]

    def take(self, kind: str | None = None, value: str | None = None) -> Tok:
        t = self.cur
        if (kind and t.kind != kind) or (value and t.value != value):
            want = value or kind
            raise TQLError(f"Expected {want} at position {t.pos}, found {t.value or 'end of query'!r}")
        self.i += 1
        return t

    def accept(self, kind: str, value: str | None = None) -> bool:
        if self.cur.kind == kind and (value is None or self.cur.value == value):
            self.i += 1
            return True
        return False

    def parse(self) -> Query:
        where = None
        if not (self.cur.kind == "kw" and self.cur.value == "ORDER") and self.cur.kind != "eof":
            where = self.or_expr()
        order = []
        if self.accept("kw", "ORDER"):
            self.take("kw", "BY")
            while True:
                f = self.field()
                direction = "asc"
                if self.cur.kind == "kw" and self.cur.value in ("ASC", "DESC"):
                    direction = self.take().value.lower()
                order.append((f, direction))
                if not self.accept("op", ","):
                    break
        self.take("eof")
        return Query(where, tuple(order))

    def nest(self):
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise TQLError("Query is nested too deeply")

    def or_expr(self):
        self.nest()
        node = self.and_expr()
        while self.accept("kw", "OR"):
            node = BoolOp("or", node, self.and_expr())
        self.depth -= 1
        return node

    def and_expr(self):
        node = self.not_expr()
        while self.accept("kw", "AND"):
            node = BoolOp("and", node, self.not_expr())
        return node

    def not_expr(self):
        if self.accept("kw", "NOT"):
            self.nest()
            n = Not(self.not_expr())
            self.depth -= 1
            return n
        if self.accept("op", "("):
            node = self.or_expr()
            self.take("op", ")")
            return node
        return self.clause()

    def field(self) -> str:
        t = self.cur
        if t.kind in ("word", "str"):
            self.i += 1
            return t.value.lower().replace(" ", "")
        raise TQLError(f"Expected a field name at position {t.pos}")

    def clause(self) -> Clause:
        f = self.field()
        t = self.cur
        if self.accept("kw", "IS"):
            negate = self.accept("kw", "NOT")
            if not (self.accept("kw", "EMPTY") or self.accept("kw", "NULL")):
                raise TQLError(f"Expected EMPTY after IS at position {self.cur.pos}")
            return Clause(f, "is_not_empty" if negate else "is_empty", ())
        if self.accept("kw", "NOT"):
            self.take("kw", "IN")
            return Clause(f, "not_in", self.value_list())
        if self.accept("kw", "IN"):
            return Clause(f, "in", self.value_list())
        if t.kind == "op" and t.value in ("=", "!=", ">", ">=", "<", "<=", "~", "!~"):
            self.i += 1
            if self.cur.kind == "kw" and self.cur.value in ("EMPTY", "NULL"):
                self.i += 1
                return Clause(f, "is_empty" if t.value == "=" else "is_not_empty", ())
            return Clause(f, t.value, (self.value(),))
        raise TQLError(f"Expected an operator after '{f}' at position {t.pos}")

    def value_list(self) -> tuple:
        if self.cur.kind == "word":  # IN openSprints() — a function returning a list
            return (self.value(),)
        self.take("op", "(")
        vals = [self.value()]
        while self.accept("op", ","):
            vals.append(self.value())
        self.take("op", ")")
        if len(vals) > 1000:
            raise TQLError("IN lists are limited to 1000 values")
        return tuple(vals)

    def value(self):
        t = self.cur
        if t.kind == "str":
            self.i += 1
            return t.value
        if t.kind == "word":
            self.i += 1
            if self.accept("op", "("):
                args = []
                if not self.accept("op", ")"):
                    args.append(self.value())
                    while self.accept("op", ","):
                        args.append(self.value())
                    self.take("op", ")")
                return Func(t.value.lower(), tuple(args))
            return t.value
        raise TQLError(f"Expected a value at position {t.pos}")


def parse(q: str) -> Query:
    if len(q) > MAX_LEN:
        raise TQLError("Query is too long")
    return Parser(tokenize(q)).parse()


# ---------- compiler ----------

REL_RE = re.compile(r"^([+-]?\d+)([dwmh])$")


class Compiler:
    def __init__(self, db: Session, user: User, accessible: list[int] | None):
        self.db, self.user, self.accessible = db, user, accessible

    # value resolution -------------------------------------------------
    def fn(self, v: Func):
        n = v.name
        if n in ("currentuser",):
            return self.user.id
        if n in ("activesprint", "opensprints", "active"):
            return list(self.db.scalars(select(Sprint.id).where(Sprint.state == "active")))
        if n in ("futuresprints",):
            return list(self.db.scalars(select(Sprint.id).where(Sprint.state == "future")))
        if n in ("closedsprints",):
            return list(self.db.scalars(select(Sprint.id).where(Sprint.state == "closed")))
        if n in ("now",):
            return datetime.now(timezone.utc)
        if n in ("startofday", "startofweek", "startofmonth"):
            off = int(v.args[0]) if v.args else 0
            d = date.today()
            if n == "startofday":
                d += timedelta(days=off)
            elif n == "startofweek":
                d = d - timedelta(days=d.weekday()) + timedelta(weeks=off)
            else:
                m = d.month - 1 + off
                d = date(d.year + m // 12, m % 12 + 1, 1)
            return d
        raise TQLError(f"Unknown function {v.name}()")

    def scalar(self, v):
        return self.fn(v) if isinstance(v, Func) else v

    def flat(self, values) -> list:
        out: list = []
        for v in values:
            r = self.scalar(v)
            out.extend(r if isinstance(r, list) else [r])
        return out

    def to_date(self, v) -> date | datetime:
        v = self.scalar(v)
        if isinstance(v, date | datetime):
            return v
        s = str(v).strip().lower()
        if m := REL_RE.match(s):
            n, unit = int(m.group(1)), m.group(2)
            delta = {"d": timedelta(days=n), "w": timedelta(weeks=n), "h": timedelta(hours=n), "m": timedelta(days=30 * n)}[unit]
            return datetime.now(timezone.utc) + delta
        try:
            return date.fromisoformat(s)
        except ValueError:
            raise TQLError(f"Invalid date {v!r} (use YYYY-MM-DD or relative like -7d)") from None

    def user_ids(self, values) -> list:
        out = []
        for v in self.flat(values):
            if isinstance(v, int):
                out.append(v)
                continue
            u = self.db.scalar(select(User.id).where(or_(func.lower(User.username) == str(v).lower(),
                                                         func.lower(User.email) == str(v).lower(),
                                                         func.lower(User.full_name) == str(v).lower())))
            out.append(u if u is not None else -1)
        return out

    # compilation ------------------------------------------------------
    def node(self, n):
        if isinstance(n, BoolOp):
            return (and_ if n.op == "and" else or_)(self.node(n.left), self.node(n.right))
        if isinstance(n, Not):
            return not_(self.node(n.node))
        return self.clause(n)

    def _cmp(self, col, op: str, vals: list, nullable: bool = True):
        if op in ("=", "in"):
            return col.in_(vals)
        if op in ("!=", "not_in"):
            return or_(col.not_in(vals), col.is_(None)) if nullable else col.not_in(vals)
        if len(vals) != 1:
            raise TQLError(f"Operator {op} takes a single value")
        v = vals[0]
        return {">": col > v, ">=": col >= v, "<": col < v, "<=": col <= v}.get(op) if op in (">", ">=", "<", "<=") else None

    def clause(self, c: Clause):
        f, op = c.field, c.op
        empty = {"is_empty": True, "is_not_empty": False}.get(op)

        if f == "project":
            if empty is not None:
                raise TQLError("project cannot be EMPTY")
            ids = []
            for v in self.flat(c.values):
                pid = self.db.scalar(select(Project.id).where(or_(Project.key == str(v).upper(), func.lower(Project.name) == str(v).lower())))
                ids.append(pid if pid is not None else -1)
            return self._need(self._cmp(Issue.project_id, op, ids, nullable=False), f, op)
        if f in ("status",):
            names = [str(v).lower() for v in self.flat(c.values)]
            ids = list(self.db.scalars(select(WorkflowStatus.id).where(func.lower(WorkflowStatus.name).in_(names)))) or [-1]
            return self._need(self._cmp(Issue.status_id, op if op in ("=", "in", "!=", "not_in") else "?", ids, nullable=False), f, op)
        if f in ("statuscategory", "category"):
            vals = [str(v).lower().replace(" ", "_").replace("todo", "todo") for v in self.flat(c.values)]
            vals = ["todo" if v in ("to_do", "todo") else v for v in vals]
            return self._need(self._cmp(WorkflowStatus.category, op, vals, nullable=False), f, op)
        if f in ("type", "issuetype"):
            vals = [str(v).lower().replace("-", "") for v in self.flat(c.values)]
            return self._need(self._cmp(Issue.issue_type, op, vals, nullable=False), f, op)
        if f == "priority":
            order = ["lowest", "low", "medium", "high", "highest"]
            vals = [str(v).lower() for v in self.flat(c.values)]
            if any(v not in order for v in vals):
                raise TQLError(f"Unknown priority; use one of {', '.join(reversed(order))}")
            if op in (">", ">=", "<", "<="):
                i = order.index(vals[0])
                rng = {">": order[i + 1:], ">=": order[i:], "<": order[:i], "<=": order[:i + 1]}[op]
                return Issue.priority.in_(rng or ["__none__"])
            return self._need(self._cmp(Issue.priority, op, vals, nullable=False), f, op)
        if f in ("assignee", "reporter"):
            col = Issue.assignee_id if f == "assignee" else Issue.reporter_id
            if empty is not None:
                return col.is_(None) if empty else col.is_not(None)
            return self._need(self._cmp(col, op, self.user_ids(c.values)), f, op)
        if f == "sprint":
            if empty is not None:
                return Issue.sprint_id.is_(None) if empty else Issue.sprint_id.is_not(None)
            ids = []
            for v in self.flat(c.values):
                if isinstance(v, int) or str(v).isdigit():
                    ids.append(int(v))
                else:
                    ids.extend(list(self.db.scalars(select(Sprint.id).where(func.lower(Sprint.name) == str(v).lower()))) or [-1])
            return self._need(self._cmp(Issue.sprint_id, op, ids or [-1]), f, op)
        if f in ("labels", "label"):
            if empty is not None:
                cond = func.jsonb_array_length(Issue.labels) == 0
                return cond if empty else not_(cond)
            vals = [str(v).lower() for v in self.flat(c.values)]
            any_ = or_(*[Issue.labels.op("@>")(cast([v], JSONB)) for v in vals])
            if op in ("=", "in"):
                return any_
            if op in ("!=", "not_in"):
                return not_(any_)
            raise TQLError("labels supports =, !=, IN, NOT IN, IS EMPTY")
        if f in ("parent", "epic", "epiclink"):
            if empty is not None:
                return Issue.parent_id.is_(None) if empty else Issue.parent_id.is_not(None)
            ids = []
            for v in self.flat(c.values):
                iid = self.db.scalar(select(Issue.id).where(or_(Issue.key == str(v).upper(),
                                                                Issue.id == (int(v) if str(v).isdigit() else -1))))
                ids.append(iid if iid is not None else -1)
            return self._need(self._cmp(Issue.parent_id, op, ids), f, op)
        if f in ("key", "issuekey", "issue"):
            keys = [str(v).upper() for v in self.flat(c.values)]
            return self._need(self._cmp(Issue.key, op, keys, nullable=False), f, op)
        if f in ("summary", "description", "text"):
            if op not in ("~", "!~"):
                raise TQLError(f"{f} supports only ~ (contains) and !~")
            term = str(self.scalar(c.values[0]))
            like = f"%{term.replace('%', r'\%').replace('_', r'\_')}%"
            cols = {"summary": [Issue.summary], "description": [Issue.description],
                    "text": [Issue.summary, Issue.description, Issue.key]}[f]
            cond = or_(*[col.ilike(like) for col in cols])
            return cond if op == "~" else not_(cond)
        if f in ("storypoints", "points", "estimate"):
            col = Issue.story_points
            if empty is not None:
                return col.is_(None) if empty else col.is_not(None)
            try:
                vals = [float(self.scalar(v)) for v in c.values]
            except (TypeError, ValueError):
                raise TQLError("storyPoints must be numeric") from None
            return self._need(self._cmp(col, op, vals), f, op)
        dates = {"due": Issue.due_date, "duedate": Issue.due_date, "start": Issue.start_date,
                 "created": Issue.created_at, "updated": Issue.updated_at, "resolved": Issue.resolved_at}
        if f in dates:
            col = dates[f]
            if empty is not None:
                return col.is_(None) if empty else col.is_not(None)
            vals = [self.to_date(v) for v in c.values]
            is_dt = f in ("created", "updated", "resolved")
            if is_dt:  # compare whole days for plain dates
                vals = [datetime.combine(v, time.min, tzinfo=timezone.utc) if type(v) is date else v for v in vals]
            else:
                vals = [v.date() if isinstance(v, datetime) else v for v in vals]
            if op == "=" and is_dt and type(self.scalar(c.values[0])) is not datetime and not REL_RE.match(str(c.values[0])):
                return and_(col >= vals[0], col < vals[0] + timedelta(days=1))
            return self._need(self._cmp(col, op, vals), f, op)
        raise TQLError(f"Unknown field '{c.field}'")

    @staticmethod
    def _need(expr, f, op):
        if expr is None:
            raise TQLError(f"Operator {op} is not supported for {f}")
        return expr

    def compile(self, q: Query) -> Select:
        stmt = select(Issue).join(WorkflowStatus, Issue.status_id == WorkflowStatus.id)
        if self.accessible is not None:
            stmt = stmt.where(Issue.project_id.in_(self.accessible) if self.accessible else false())
        if q.where is not None:
            stmt = stmt.where(self.node(q.where))
        # JQL semantics: "priority DESC" lists highest first, so use an ascending-importance weight.
        order_map = {**SORTS, "priority": 0 - SORTS["priority"], "duedate": SORTS["due"],
                     "storypoints": SORTS["points"], "status": WorkflowStatus.position}
        for fname, direction in q.order or (("rank", "asc"),):
            col = order_map.get(fname)
            if col is None:
                raise TQLError(f"Cannot ORDER BY '{fname}'")
            stmt = stmt.order_by(col.desc().nulls_last() if direction == "desc" else col.asc().nulls_last())
        return stmt.order_by(Issue.id)


def compile_tql(db: Session, user: User, accessible: list[int] | None, query: str) -> Select:
    return Compiler(db, user, accessible).compile(parse(query))
