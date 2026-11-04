import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAvatarMimeType, isValidAvatarImage } from "@openbot/contracts/avatar-images";
import type {
  AgentPublicationPreview,
  AgentSubmission,
  AgentTemplateDetail,
  AgentTemplateSnapshot,
  AvatarImageInput,
  MarketplaceAgentDetail,
  MarketplaceAgentQuery,
  MarketplaceSkillQuery,
  SkillCategory,
} from "@openbot/contracts/ipc";
import { decodeAgentTemplateDetail, decodeMarketplaceAgentDetail } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Schema, Semaphore } from "effect";
import { writeJsonFileAtomically } from "../backend/atomic-json-file";

interface StoredAvatar {
  mimeType: string;
  base64: string;
}
interface AgentEntry {
  sourceAgentId: string;
  detail: MarketplaceAgentDetail;
  avatar: StoredAvatar | null;
}
export interface LocalTemplateEntry {
  sourceAgentId: string;
  detail: AgentTemplateDetail;
  avatar: StoredAvatar | null;
}
interface CatalogFile {
  version: 1;
  agents: AgentEntry[];
  templates: LocalTemplateEntry[];
}
export class LocalCatalogFailure extends Schema.TaggedError<LocalCatalogFailure>()("LocalCatalogFailure", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
const empty = (): CatalogFile => ({ version: 1, agents: [], templates: [] });
const failed = () => {
  const message = sourceText("error.marketplace.localCatalogUnavailable");
  return new LocalCatalogFailure({ message, cause: new Error(message) });
};

function avatarImage(value: StoredAvatar | null): AvatarImageInput | null {
  if (!value) return null;
  const bytes = Buffer.from(value.base64, "base64");
  if (!isAvatarMimeType(value.mimeType) || !isValidAvatarImage(value.mimeType, bytes)) throw failed();
  return { mimeType: value.mimeType, bytes };
}
function readAvatar(value: unknown): StoredAvatar | null {
  if (value === null) return null;
  if (
    !isDynamicRecord(value) ||
    typeof value.mimeType !== "string" ||
    typeof value.base64 !== "string" ||
    value.base64.length > 8 * 1024 * 1024
  )
    throw failed();
  const result = { mimeType: value.mimeType, base64: value.base64 };
  avatarImage(result);
  return result;
}
function storeAvatar(value: AvatarImageInput | null): StoredAvatar | null {
  if (value && !isValidAvatarImage(value.mimeType, value.bytes)) throw failed();
  return value ? { mimeType: value.mimeType, base64: Buffer.from(value.bytes).toString("base64") } : null;
}

/** Local publications contain snapshots only; they never modify the original agent or its cloud records. */
export class LocalMarketplaceCatalog {
  readonly #writes = Semaphore.makeUnsafe(1);
  constructor(private readonly path: string) {}

  private read(): Effect.Effect<CatalogFile, LocalCatalogFailure> {
    return Effect.tryPromise({
      try: async (): Promise<CatalogFile> => {
        try {
          const info = await stat(this.path);
          if (!info.isFile() || info.size > 64 * 1024 * 1024) throw failed();
          const value = JSON.parse(await readFile(this.path, "utf8"));
          if (
            !isDynamicRecord(value) ||
            value.version !== 1 ||
            !Array.isArray(value.agents) ||
            !Array.isArray(value.templates)
          )
            throw failed();
          const agents = value.agents.map((entry): AgentEntry => {
            if (!isDynamicRecord(entry) || typeof entry.sourceAgentId !== "string") throw failed();
            return {
              sourceAgentId: entry.sourceAgentId,
              detail: decodeMarketplaceAgentDetail(entry.detail),
              avatar: readAvatar(entry.avatar),
            };
          });
          const templates = value.templates.map((entry): LocalTemplateEntry => {
            if (!isDynamicRecord(entry) || typeof entry.sourceAgentId !== "string") throw failed();
            return {
              sourceAgentId: entry.sourceAgentId,
              detail: decodeAgentTemplateDetail(entry.detail),
              avatar: readAvatar(entry.avatar),
            };
          });
          return { version: 1, agents, templates };
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return empty();
          throw cause;
        }
      },
      catch: failed,
    });
  }
  private save(file: CatalogFile) {
    return writeJsonFileAtomically(this.path, file, { createDirectory: true }).pipe(Effect.mapError(failed));
  }
  listAgents(query: MarketplaceAgentQuery) {
    return this.read().pipe(
      Effect.map((file) =>
        localCatalogPage(
          file.agents.map((entry) => entry.detail),
          query,
        ),
      ),
    );
  }
  getAgent(id: string) {
    return this.read().pipe(
      Effect.flatMap((file) => {
        const found = file.agents.find((entry) => entry.detail.id === id);
        return found ? Effect.succeed(found.detail) : Effect.fail(failed());
      }),
    );
  }
  agentAvatar(id: string) {
    return this.read().pipe(
      Effect.map((file) => avatarImage(file.agents.find((entry) => entry.detail.id === id)?.avatar ?? null)),
    );
  }
  listSubmissions() {
    return this.read().pipe(Effect.map((file) => file.agents.map((entry) => submission(entry.detail))));
  }
  publishAgent(
    preview: AgentPublicationPreview,
    category: SkillCategory | undefined,
    avatar: AvatarImageInput | null,
    listingId?: string,
  ) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const file = yield* this.read();
        const previous = listingId
          ? file.agents.find((entry) => entry.detail.id === listingId && entry.sourceAgentId === preview.agentId)
          : file.agents.find((entry) => entry.sourceAgentId === preview.agentId);
        if (listingId && !previous) return yield* Effect.fail(failed());
        const id = previous?.detail.id ?? randomUUID();
        const version = (previous?.detail.version ?? 0) + 1;
        const detail: MarketplaceAgentDetail = {
          id,
          name: preview.name,
          title: preview.title,
          description: preview.description,
          creatorName: "Local",
          category: category ?? "other",
          version,
          versionId: String(version),
          installs: 0,
          featured: false,
          verified: false,
          avatarSeed: preview.avatarSeed,
          avatarHue: preview.avatarHue,
          avatarUrl: null,
          skillCount: preview.skills.length,
          routineCount: preview.routines.length,
          activeRoutineCount: preview.routines.filter((routine) => routine.active).length,
          updatedAt: new Date().toISOString(),
          skills: preview.skills,
          routines: preview.routines,
        };
        file.agents = [
          ...file.agents.filter((entry) => entry.detail.id !== id),
          { sourceAgentId: preview.agentId, detail, avatar: storeAvatar(avatar) },
        ];
        yield* this.save(file);
        return submission(detail);
      }).pipe(Effect.uninterruptible),
    );
  }
  ownedTemplate(sourceAgentId: string) {
    return this.read().pipe(
      Effect.map((file) => file.templates.find((entry) => entry.sourceAgentId === sourceAgentId) ?? null),
    );
  }
  getTemplate(id: string) {
    return this.read().pipe(
      Effect.flatMap((file) => {
        const entry = file.templates.find((template) => template.detail.id === id);
        return entry ? Effect.succeed(entry.detail) : Effect.fail(failed());
      }),
    );
  }
  templateAvatar(id: string) {
    return this.read().pipe(
      Effect.map((file) => avatarImage(file.templates.find((entry) => entry.detail.id === id)?.avatar ?? null)),
    );
  }
  publishTemplate(sourceAgentId: string, snapshot: AgentTemplateSnapshot, avatar: AvatarImageInput | null) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const file = yield* this.read();
        const previous = file.templates.find((entry) => entry.sourceAgentId === sourceAgentId);
        const id = previous?.detail.id ?? randomBytes(16).toString("base64url");
        const detail: AgentTemplateDetail = {
          ...snapshot,
          id,
          creatorName: "Local",
          avatarUrl: null,
          updatedAt: new Date().toISOString(),
        };
        file.templates = [
          ...file.templates.filter((entry) => entry.sourceAgentId !== sourceAgentId),
          { sourceAgentId, detail, avatar: storeAvatar(avatar) },
        ];
        yield* this.save(file);
        return { id, sourceAgentId, updatedAt: detail.updatedAt };
      }).pipe(Effect.uninterruptible),
    );
  }
  unpublishTemplate(sourceAgentId: string) {
    return this.#writes.withPermit(
      Effect.gen({ self: this }, function* () {
        const file = yield* this.read();
        file.templates = file.templates.filter((entry) => entry.sourceAgentId !== sourceAgentId);
        yield* this.save(file);
      }).pipe(Effect.uninterruptible),
    );
  }
}

export function localCatalogPage<
  T extends {
    name: string;
    description: string;
    category?: SkillCategory;
    featured: boolean;
    verified?: boolean;
    updatedAt: string;
  },
>(items: readonly T[], query: MarketplaceSkillQuery) {
  const needle = query.query?.trim().toLowerCase() ?? "";
  const filtered = items.filter(
    (item) =>
      (!needle || `${item.name} ${item.description}`.toLowerCase().includes(needle)) &&
      (!query.category || item.category === query.category) &&
      (!query.featured || item.featured) &&
      (query.verified === undefined || Boolean(item.verified) === query.verified),
  );
  const ordered = [...filtered].sort((a, b) =>
    query.sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt),
  );
  const offset = query.cursor && /^\d+$/u.test(query.cursor) ? Number(query.cursor) : 0;
  const limit = Math.max(1, Math.min(100, query.limit ?? 50));
  return {
    items: ordered.slice(offset, offset + limit),
    nextCursor: offset + limit < ordered.length ? String(offset + limit) : null,
  };
}
function submission(detail: MarketplaceAgentDetail): AgentSubmission {
  return {
    id: detail.versionId,
    listingId: detail.id,
    name: detail.name,
    title: detail.title,
    description: detail.description,
    category: detail.category ?? "other",
    version: detail.version,
    status: "approved",
    rejectionNote: null,
    avatarSeed: detail.avatarSeed,
    avatarHue: detail.avatarHue,
    avatarUrl: detail.avatarUrl,
    skillCount: detail.skillCount,
    routineCount: detail.routineCount,
    activeRoutineCount: detail.activeRoutineCount,
    createdAt: detail.updatedAt,
  };
}
