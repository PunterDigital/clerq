// Open and Download for an expense's receipt. Both point at the session-gated
// receipt route (app/api/expenses/[expenseId]/receipt, #5693), which serves
// the stored file with its own type: Open shows it inline in a new tab,
// Download asks for an attachment. Plain links, so no receipt bytes reach
// the page (they used to arrive as a data URL prop for a blob: workaround).
export function ReceiptLinks({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline-offset-4 hover:underline"
      >
        Open
      </a>
      <a
        href={`${url}?download=1`}
        download={filename}
        className="text-primary underline-offset-4 hover:underline"
      >
        Download
      </a>
    </div>
  );
}
