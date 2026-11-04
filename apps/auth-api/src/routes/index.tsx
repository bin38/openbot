import { INDEPENDENT_EDITION } from "@openbot/contracts/product-edition";
import { createFileRoute } from "@tanstack/solid-router";
import { IndependentEditionPage, independentPageText } from "../components/landing/IndependentEditionPage";
import { LandingPage } from "../components/landing/LandingPage";
import { loadPageText } from "../lib/page-text";
import { openBotHomeHead } from "../lib/site-metadata";
import { OPENBOT_SOFTWARE_APPLICATION } from "../lib/software-application";

export const Route = createFileRoute("/")({
  loader: ({ context }) => loadPageText(context.locale, independentPageText),
  head: ({ loaderData }) =>
    INDEPENDENT_EDITION
      ? { meta: [{ title: loaderData?.text.title }, { name: "description", content: loaderData?.text.description }] }
      : openBotHomeHead(OPENBOT_SOFTWARE_APPLICATION),
  component: Home,
});

function Home() {
  const page = Route.useLoaderData();
  return INDEPENDENT_EDITION ? <IndependentEditionPage {...page()} /> : <LandingPage />;
}
