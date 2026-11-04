import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { createFileRoute, redirect } from "@tanstack/solid-router";
import { DownloadHubPage } from "../../components/download/DownloadHubPage";

// `head` imports the pages when it runs, as in routes/compare/$slug.tsx.
export const Route = createFileRoute("/download/")({
  beforeLoad: () => {
    if (INDEPENDENT_EDITION) throw redirect({ to: "/", statusCode: 307 });
  },
  head: async ({ match }) => {
    const { downloadPageHead } = await import("../../lib/download-pages");
    return downloadPageHead("hub", match.context.siteUrl);
  },
  component: DownloadHubPage,
});
