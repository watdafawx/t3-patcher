#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const t3SourcePath = resolve(repoRoot, "packages/api/src/t3.ts");
const outputPath = resolve(repoRoot, "docs/api.md");

const sourceText = readFileSync(t3SourcePath, "utf8");
const sourceFile = ts.createSourceFile("t3.ts", sourceText, ts.ScriptTarget.Latest, true);

/**
 * Clean up JSDoc text, converting {@link Target} into `Target`.
 */
function cleanDoc(text) {
  if (!text) return "";
  return text
    .replace(/\{@link\s+([^}]+)\}/g, "`$1`")
    .replace(/\r\n/g, "\n")
    .trim();
}

function getNodeDoc(node) {
  if (!node.jsDoc || node.jsDoc.length === 0) return "";
  const docs = [];
  for (const jd of node.jsDoc) {
    const comment = ts.getTextOfJSDocComment(jd.comment);
    if (comment) docs.push(cleanDoc(comment));
  }
  return docs.join("\n\n");
}

function getMemberDoc(member) {
  if (!member.jsDoc || member.jsDoc.length === 0) return "";
  const docs = [];
  for (const jd of member.jsDoc) {
    const comment = ts.getTextOfJSDocComment(jd.comment);
    if (comment) docs.push(cleanDoc(comment));
  }
  return docs.join(" ");
}

/**
 * Statement map by name.
 */
const statementsByName = new Map();

for (const statement of sourceFile.statements) {
  if (statement.name && ts.isIdentifier(statement.name)) {
    statementsByName.set(statement.name.text, statement);
  } else if (ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        statementsByName.set(decl.name.text, statement);
      }
    }
  }
}

/**
 * Namespaces and their symbols.
 */
const namespaces = [
  {
    id: "core-and-lifecycle",
    title: "Core and Lifecycle",
    description: "Common types, plugin module interface, lifecycle contracts, and disposable handles.",
    symbols: ["PluginModule", "PluginCleanup", "T3Disposable", "Unsubscribe", "JsonValue", "T3LogLevel", "T3_API_VERSION"],
  },
  {
    id: "root-api",
    title: "t3 (Root API)",
    description: "The root `T3Api` instance provided to plugin modules, plugin metadata, and development helpers.",
    symbols: ["T3Api", "T3PluginInfo", "T3Dev"],
  },
  {
    id: "t3-rpc",
    title: "t3.rpc",
    description: "Direct Effect RPC communication over the shared authenticated WebSocket with the T3 Code server.",
    symbols: ["T3Rpc", "T3RpcSubscribeOptions", "T3RpcSubscription"],
  },
  {
    id: "t3-providers",
    title: "t3.providers",
    description: "Inspection of connected AI providers, authentication states, and rate limits.",
    symbols: ["T3Providers", "ProviderSnapshot", "ProviderUsageLimits"],
  },
  {
    id: "t3-threads",
    title: "t3.threads",
    description: "Session thread inspection, projection streaming, model changes, and provider switching.",
    symbols: ["T3Threads", "ModelSelection", "ThreadSummary", "ThreadProjection", "OrchestrationCommand", "DispatchResult", "SwitchResult"],
  },
  {
    id: "t3-timeline",
    title: "t3.timeline",
    description: "Normalized event stream and cause chains for thread turn items, requests, and tool calls.",
    symbols: ["T3Timeline", "TimelineRecord", "TimelineKind", "CauseRelation", "TimelineCause", "ProviderFrame", "TimelineEnrichment"],
  },
  {
    id: "t3-cache",
    title: "t3.cache",
    description: "Prompt-cache countdown tracking, TTL state, and expiration notifications.",
    symbols: ["T3Cache", "CacheState"],
  },
  {
    id: "t3-usage",
    title: "t3.usage",
    description: "Token usage aggregation by time range, session thread, and provider instance.",
    symbols: ["T3Usage", "UsageRange", "TokenTotals", "UsageSummary"],
  },
  {
    id: "t3-ui",
    title: "t3.ui",
    description: "DOM slot mounting across the application, toasts, modal dialogs, and theme tokens.",
    symbols: ["T3Ui", "UiSlotRegistration", "UiSlotName", "UiSlotContext", "ToastOptions", "ModalOptions"],
  },
  {
    id: "t3-commands",
    title: "t3.commands",
    description: "Command palette action registration and execution.",
    symbols: ["T3Commands", "CommandRegistration"],
  },
  {
    id: "t3-keybinds",
    title: "t3.keybinds",
    description: "Keyboard shortcut bindings mapped to commands.",
    symbols: ["T3Keybinds", "KeybindRegistration"],
  },
  {
    id: "t3-patches",
    title: "t3.patches",
    description: "Tier 3 raw chunk text patches for runtime code transformation.",
    symbols: ["T3Patches", "PluginPatch", "PluginPatchReplacement"],
  },
  {
    id: "t3-internals",
    title: "t3.internals",
    description: "Tier 2 handles into captured app singletons (router, atom registry, dispatcher).",
    symbols: ["T3Internals", "InternalHandles", "InternalCaptureState"],
  },
  {
    id: "t3-storage",
    title: "t3.storage",
    description: "Per-plugin isolated key-value JSON storage backed by the patcher home directory.",
    symbols: ["T3Storage"],
  },
  {
    id: "t3-settings",
    title: "t3.settings",
    description: "Schema-driven plugin configuration with built-in settings UI rendering.",
    symbols: [
      "T3Settings",
      "SettingSchema",
      "SettingBase",
      "BooleanSettingSchema",
      "StringSettingSchema",
      "NumberSettingSchema",
      "EnumSettingSchema",
      "SettingValue",
      "SettingChange",
    ],
  },
  {
    id: "t3-native",
    title: "t3.native",
    description: "Permission-gated main process services: scoped filesystem reads, SQLite queries, log tailing, and process spawning.",
    symbols: [
      "T3Native",
      "NativeFsReadRequest",
      "NativeFsReadResult",
      "NativeSqliteQueryRequest",
      "NativeSqliteQueryResult",
      "NativeLogTailRequest",
      "NativeLogTailResult",
      "NativeSpawnRequest",
      "NativeSpawnResult",
    ],
  },
  {
    id: "t3-events",
    title: "t3.events",
    description: "Application lifecycle hooks and inter-plugin event bus.",
    symbols: ["T3Events", "T3EventMap", "T3EventBus"],
  },
];

const out = [];

out.push("# T3 Patcher API reference");
out.push("");
out.push("This document is generated directly from `@t3p/api` type definitions in `packages/api/src/t3.ts`.");
out.push("It provides the complete API reference for the frozen `t3` object available to plugin modules.");
out.push("");
out.push("## Table of contents");
out.push("");

for (const ns of namespaces) {
  out.push(`- [${ns.title}](#${ns.id})`);
}

out.push("");

for (const ns of namespaces) {
  out.push(`## <a id="${ns.id}"></a>${ns.title}`);
  out.push("");
  out.push(ns.description);
  out.push("");

  for (const name of ns.symbols) {
    const node = statementsByName.get(name);
    if (!node) continue;

    out.push(`### \`${name}\``);
    out.push("");

    const doc = getNodeDoc(node);
    if (doc) {
      out.push(doc);
      out.push("");
    }

    const code = node.getText(sourceFile).trim();
    out.push("```ts");
    out.push(code);
    out.push("```");
    out.push("");

    // If interface with documented members, list them
    if (ts.isInterfaceDeclaration(node) && node.members.length > 0) {
      const documentedMembers = [];
      for (const member of node.members) {
        const memberDoc = getMemberDoc(member);
        if (memberDoc) {
          const memberName = member.name ? member.name.getText(sourceFile) : "";
          documentedMembers.push({ name: memberName, doc: memberDoc });
        }
      }

      if (documentedMembers.length > 0) {
        out.push("#### Members");
        out.push("");
        for (const m of documentedMembers) {
          out.push(`- \`${m.name}\`: ${m.doc}`);
        }
        out.push("");
      }
    }
  }
}

writeFileSync(outputPath, out.join("\n") + "\n", "utf8");
console.log(`Generated API reference at ${outputPath} (${out.length} lines)`);
