import { useParams } from "react-router-dom";
import { IssueView } from "../components/IssueView";

export default function IssuePage() {
  const { issueKey } = useParams();
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <div className="rounded-lg border bg-surface">
        <IssueView key={issueKey} issueKey={issueKey!} />
      </div>
    </div>
  );
}
