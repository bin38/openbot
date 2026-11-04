import type { AppTranslate } from "@openbot/i18n";
import { TextProvider } from "@openbot/ui/text";
import { OPENBOT_LINKS } from "../../lib/landing-links";
import type { PageText } from "../../lib/page-text";
import { TransactionalPage } from "../transactional/TransactionalPage";
import { Button } from "../ui/button";

export function independentPageText(t: AppTranslate) {
  return {
    title: t("webClient.independent.title"),
    heading: t("webClient.independent.heading"),
    description: t("webClient.independent.description"),
    setup: t("webClient.independent.setup"),
    downloads: t("webClient.independent.downloads"),
    remote: t("webClient.independent.remote"),
    providers: t("webClient.independent.providers"),
    source: t("webClient.independent.source"),
    build: t("webClient.independent.build"),
  };
}

export function IndependentEditionPage(props: PageText<ReturnType<typeof independentPageText>>) {
  return (
    <TextProvider locale={props.locale}>
      <TransactionalPage titleId="independent-edition-title" lang={props.lang} layout="form">
        <h1 id="independent-edition-title">{props.text.heading}</h1>
        <p>{props.text.description}</p>
        <p>{props.text.setup}</p>
        <p>{props.text.downloads}</p>
        <p>{props.text.remote}</p>
        <p>{props.text.providers}</p>
        <div class="join-actions">
          <Button href={OPENBOT_LINKS.repository} variant="primary" icon="github">
            {props.text.source}
          </Button>
          <Button href={OPENBOT_LINKS.documentation} variant="secondary" icon="open">
            {props.text.build}
          </Button>
        </div>
      </TransactionalPage>
    </TextProvider>
  );
}
