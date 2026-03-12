#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type State = {
  activeProfile?: string;
  lastSwitchedAt?: string;
  generatedBy?: string;
};

type Paths = {
  claudeDir: string;
  baseFile: string;
  profilesDir: string;
  targetFile: string;
  stateFile: string;
  backupFile: string;
};

const VERSION = "0.1.0";
const SECRET_KEY_RE = /(key|token|secret|password|credential|auth|cookie|session|bearer|private)/i;
const CLI_NAME = "ccs";
const DEFAULT_MODEL_ENV_KEYS = [
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
] as const;

function main() {
  const args = process.argv.slice(2);
  const { flags, positionals } = parseArgs(args);
  const configDir = typeof flags["config-dir"] === "string" ? flags["config-dir"] : undefined;
  const paths = resolvePaths(configDir);
  const command = positionals[0] ?? "help";

  // Support common global flags: `ccs --help`, `ccs --version`
  if (flags.help || flags.h) {
    printHelp();
    return;
  }
  if (flags.version || flags.v) {
    console.log(VERSION);
    return;
  }

  try {
    switch (command) {
      case "init":
        runInit(paths, flags);
        break;
      case "new":
        runNew(paths, flags);
        break;
      case "rollback":
        runRollback(paths, flags);
        break;
      case "list":
        runList(paths, flags);
        break;
      case "current":
        runCurrent(paths, flags);
        break;
      case "use":
        runUse(paths, positionals[1], flags);
        break;
      case "dump":
        runDump(paths, positionals[1], flags);
        break;
      case "validate":
        runValidate(paths, flags);
        break;
      case "paths":
        runPaths(paths);
        break;
      case "help":
      case "-h":
      case "--help":
        printHelp();
        break;
      case "version":
      case "-v":
      case "--version":
        console.log(VERSION);
        break;
      default:
        fail(`unknown command: ${command}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function resolvePaths(configDirFlag?: string): Paths {
  const claudeDir = configDirFlag ? resolve(configDirFlag) : join(homedir(), ".claude");
  return {
    claudeDir,
    baseFile: join(claudeDir, "settings.base.json"),
    profilesDir: join(claudeDir, "profiles"),
    targetFile: join(claudeDir, "settings.json"),
    stateFile: join(claudeDir, ".switcher-state.json"),
    backupFile: join(claudeDir, "settings.switcher.backup.json"),
  };
}

function runInit(paths: Paths, flags: Record<string, string | boolean>) {
  const from = typeof flags.from === "string" ? flags.from : paths.targetFile;
  const force = Boolean(flags.force);

  if (!existsSync(from)) {
    fail(`init source not found: ${from}`);
  }

  if (!force) {
    if (existsSync(paths.baseFile)) {
      fail(`base file already exists (use --force to overwrite): ${paths.baseFile}`);
    }
    if (existsSync(paths.profilesDir)) {
      const anyProfile = new Bun.Glob("*.json").scanSync(paths.profilesDir).next().value;
      if (anyProfile) {
        fail(`profiles already exist (use --force to overwrite): ${paths.profilesDir}`);
      }
    }
  }

  const src = loadJsonFile(from);
  const env = getObject(src.env);
  const base: JsonObject = { ...src };

  if (env) {
    // Remove provider-specific values from the base.
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    base.env = env;
  }

  // Conservative default: do not skip dangerous mode prompt.
  delete base.skipDangerousModePermissionPrompt;

  mkdirSync(paths.profilesDir, { recursive: true });
  atomicWriteJson(paths.baseFile, base);

  console.log(`Wrote base: ${paths.baseFile}`);
  console.log(`Profiles dir: ${paths.profilesDir}`);
  console.log(`Next: create one or more profiles with env.ANTHROPIC_BASE_URL + env.ANTHROPIC_AUTH_TOKEN, then run use <profile>.`);
}

function runNew(paths: Paths, flags: Record<string, string | boolean>) {
  mkdirSync(paths.profilesDir, { recursive: true });

  const rawName = typeof flags.name === "string" ? flags.name : prompt("Profile name:")?.trim();
  if (!rawName) {
    fail("profile name is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(rawName)) {
    fail("profile name may only contain letters, numbers, dot, underscore, and hyphen");
  }

  const baseUrl =
    typeof flags["base-url"] === "string" ? flags["base-url"] : prompt("Base URL:")?.trim();
  if (!baseUrl) {
    fail("base URL is required");
  }

  const authToken =
    typeof flags.key === "string"
      ? flags.key
      : typeof flags.token === "string"
        ? flags.token
        : prompt("Token / key:")?.trim();
  if (!authToken) {
    fail("token / key is required");
  }

  // Some providers need an env-level model (proxy-side routing), e.g. ANTHROPIC_MODEL=qwen3.5-plus.
  const providerModel =
    typeof flags.model === "string"
      ? flags.model
      : (prompt("Provider model (env ANTHROPIC_MODEL, optional):")?.trim() ?? "");
  const modelAlias = providerModel ? slugifyForFileName(providerModel) : "";

  // Claude Code model should be controlled by the base config, not individual profiles.
  if (typeof flags["cc-model"] === "string" && flags["cc-model"].trim()) {
    fail("cc-model override is not supported. Keep Claude Code model in settings.base.json (e.g. opus).");
  }

  // Convention: if model is set, profile name should be `name-model.json`
  const finalName =
    modelAlias && !rawName.endsWith(`-${modelAlias}`) ? `${rawName}-${modelAlias}` : rawName;
  const targetFile = join(paths.profilesDir, `${finalName}.json`);
  if (existsSync(targetFile) && !flags.force) {
    const answer = prompt(`Profile already exists: ${finalName}. Overwrite? [y/N]`)?.trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      return;
    }
  }

  const profile: JsonObject = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
    },
  };
  if (providerModel) {
    const env = getObject(profile.env);
    if (!env) {
      fail("internal error: profile.env is not an object");
    }
    env.ANTHROPIC_MODEL = providerModel;
    // If a provider model is specified, default all Claude Code tiers to it unless overridden later.
    // This supports proxy-side routing (e.g. volc/aliyun) where "haiku/sonnet/opus" should map to one provider model.
    for (const key of DEFAULT_MODEL_ENV_KEYS) {
      env[key] = providerModel;
    }
  }
  atomicWriteJson(targetFile, profile);

  console.log(`Created profile: ${finalName}`);
  console.log(`File: ${targetFile}`);
}

function runList(paths: Paths, flags: Record<string, string | boolean>) {
  const profiles = loadProfiles(paths);
  const active = detectActiveProfile(paths, profiles);
  if (flags.json) {
    console.log(JSON.stringify({ activeProfile: active, profiles: profiles.map((p) => p.name) }, null, 2));
    return;
  }
  if (profiles.length === 0) {
    console.log(`No profiles found in ${paths.profilesDir}`);
    return;
  }
  printProfileChoices(profiles, active);
}

function runCurrent(paths: Paths, flags: Record<string, string | boolean>) {
  const profiles = loadProfiles(paths);
  const active = detectActiveProfile(paths, profiles);
  const state = loadOptionalJsonFile(paths.stateFile);
  const currentSettings = existsSync(paths.targetFile) ? loadOptionalJsonFile(paths.targetFile) : null;
  const baseSettings = existsSync(paths.baseFile) ? loadOptionalJsonFile(paths.baseFile) : null;
  const env = currentSettings ? getObject(currentSettings.env) : null;
  const baseUrl = env ? getString(env.ANTHROPIC_BASE_URL) : null;
  const providerModel = env ? getString(env.ANTHROPIC_MODEL) : null;
  const baseModel = baseSettings ? getString(baseSettings.model) : null;
  const settingsModel = currentSettings ? getString(currentSettings.model) : null;
  const lastSwitchedAt = state ? getString(state.lastSwitchedAt) : null;
  const generatedBy = state ? getString(state.generatedBy) : null;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          activeProfile: active,
          baseUrl,
          providerModel,
          baseModel,
          settingsModel,
          settingsFile: paths.targetFile,
          stateFile: paths.stateFile,
          lastSwitchedAt,
          generatedBy,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Profile: ${active ?? "unknown"}`);
  console.log(`Base URL: ${baseUrl ?? "unknown"}`);
  if (providerModel) {
    console.log(`Provider model: ${providerModel}`);
  }
  if (baseModel) {
    console.log(`Claude Code model (base): ${baseModel}`);
  }
  console.log(`Claude Code model (settings.json): ${settingsModel ?? "unknown"}`);
  if (baseModel && settingsModel && baseModel !== settingsModel) {
    console.log(`Warning: settings.json model differs from base. Run \`${CLI_NAME} use ${active ?? "<profile>"}\` to normalize.`);
  }
  console.log(`Settings: ${paths.targetFile}`);
  if (lastSwitchedAt) {
    console.log(`Last switched: ${lastSwitchedAt}`);
  }
  if (generatedBy) {
    console.log(`Generated by: ${generatedBy}`);
  }
}

function runUse(paths: Paths, profileName: string | undefined, flags: Record<string, string | boolean>) {
  const base = loadJsonFile(paths.baseFile);
  const profiles = loadProfiles(paths);
  const active = detectActiveProfile(paths, profiles);
  if (profiles.length === 0) {
    fail(`no profiles found in ${paths.profilesDir}`);
  }

  let selectedInput = profileName;
  if (!selectedInput) {
    printProfileChoices(profiles, active);
    const answer = prompt("Select a profile by number or name (Enter to cancel):")?.trim();
    if (!answer) {
      console.log("Cancelled.");
      return;
    }
    selectedInput = answer;
  }

  const profile = resolveProfileSelection(profiles, selectedInput);
  if (!profile) {
    const known = profiles.map((item) => item.name).join(", ");
    fail(`profile not found: ${selectedInput}${known ? ` (known: ${known})` : ""}`);
  }
  const merged = deepMerge(base, profile.data);
  applyBaseOverrides(base, merged);
  // Ensure optional env mappings present in the profile are carried into the final merged config.
  applyProfileEnvOverrides(profile.data, merged);
  validateMergedConfig(merged, profile.name, paths);

  if (flags["dry-run"]) {
    console.log(JSON.stringify(redactSecrets(merged), null, 2));
    return;
  }

  mkdirSync(dirname(paths.targetFile), { recursive: true });
  if (existsSync(paths.targetFile)) {
    copyFileSync(paths.targetFile, paths.backupFile);
  }
  atomicWriteJson(paths.targetFile, merged);
  atomicWriteJson(paths.stateFile, {
    activeProfile: profile.name,
    lastSwitchedAt: new Date().toISOString(),
    generatedBy: `${CLI_NAME}/${VERSION}`,
  } satisfies State);

  console.log(`Switched to profile: ${profile.name}`);
  console.log(`Wrote ${paths.targetFile}`);
  console.log(`Backup: ${paths.backupFile}`);
}

function applyProfileEnvOverrides(profile: JsonObject, merged: JsonObject) {
  const profileEnv = getObject(profile.env);
  const mergedEnv = getObject(merged.env);
  if (!profileEnv || !mergedEnv) {
    return;
  }
  for (const key of DEFAULT_MODEL_ENV_KEYS) {
    if (key in profileEnv) {
      const value = profileEnv[key];
      if (value !== undefined) {
        mergedEnv[key] = clone(value);
      }
    }
  }
}

function runRollback(paths: Paths, flags: Record<string, string | boolean>) {
  if (!existsSync(paths.backupFile)) {
    fail(`backup file not found: ${paths.backupFile}`);
  }

  const backupSettings = loadJsonFile(paths.backupFile);
  const currentSettings = existsSync(paths.targetFile) ? loadJsonFile(paths.targetFile) : null;

  // Simple and reversible: swap settings.json <-> settings.switcher.backup.json
  atomicWriteJson(paths.targetFile, backupSettings);
  if (currentSettings) {
    atomicWriteJson(paths.backupFile, currentSettings);
  }

  const profiles = loadProfiles(paths);
  const base = loadOptionalJsonFile(paths.baseFile);
  const detected = base ? detectActiveProfileByCompare(backupSettings, base, profiles) : null;
  const state: JsonObject = {
    lastSwitchedAt: new Date().toISOString(),
    generatedBy: `${CLI_NAME}/${VERSION}`,
  };
  if (detected) {
    state.activeProfile = detected;
  }
  atomicWriteJson(paths.stateFile, state);

  console.log(`Rolled back settings.json from ${paths.backupFile}`);
  console.log(`Settings: ${paths.targetFile}`);
  if (currentSettings) {
    console.log(`Backup swapped to previous current settings: ${paths.backupFile}`);
  }
  if (detected) {
    console.log(`Detected profile: ${detected}`);
  }
  if (flags["dry-run"]) {
    console.log("Note: --dry-run is not supported for rollback (operation already completed).");
  }
}

function runDump(paths: Paths, profileName: string | undefined, flags: Record<string, string | boolean>) {
  if (!profileName) {
    fail("usage: dump <profile>");
  }
  const base = loadJsonFile(paths.baseFile);
  const profiles = loadProfiles(paths);
  const profile = profiles.find((item) => item.name === profileName);
  if (!profile) {
    fail(`profile not found: ${profileName}`);
  }
  const merged = deepMerge(base, profile.data);
  applyBaseOverrides(base, merged);
  const output = flags.raw ? merged : redactSecrets(merged);
  console.log(JSON.stringify(output, null, 2));
}

function runValidate(paths: Paths, flags: Record<string, string | boolean>) {
  const base = loadJsonFile(paths.baseFile);
  const profiles = loadProfiles(paths);
  if (profiles.length === 0) {
    fail(`no profiles found in ${paths.profilesDir}`);
  }
  validateBaseConfig(base, paths);
  const results = profiles.map((profile) => {
    const profileTopModel = getString(profile.data.model);
    const merged = deepMerge(base, profile.data);
    applyBaseOverrides(base, merged);
    validateMergedConfig(merged, profile.name, paths);
    return {
      name: profile.name,
      baseUrl: getString(getNested(merged, ["env", "ANTHROPIC_BASE_URL"])) ?? "",
      providerModel: getString(getNested(merged, ["env", "ANTHROPIC_MODEL"])) ?? "",
      model: getString((merged as JsonObject).model) ?? "",
      profileTopModel: profileTopModel ?? "",
    };
  });
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, profiles: results }, null, 2));
    return;
  }
  console.log(`Base: ${paths.baseFile}`);
  for (const result of results) {
    const extra: string[] = [];
    if (result.providerModel) {
      extra.push(`providerModel=${result.providerModel}`);
    }
    if (result.model) {
      extra.push(`model=${result.model}`);
    }
    if (result.profileTopModel) {
      extra.push(`profileModelIgnored=${result.profileTopModel}`);
    }
    const suffix = extra.length ? ` (${extra.join(", ")})` : "";
    console.log(`OK ${result.name} -> ${result.baseUrl}${suffix}`);
  }
}

function runPaths(paths: Paths) {
  console.log(JSON.stringify(paths, null, 2));
}

function validateBaseConfig(base: JsonObject, paths: Paths) {
  const env = getObject(base.env);
  if (!env) {
    fail(`base config is missing env: ${paths.baseFile}`);
  }
  if ("ANTHROPIC_AUTH_TOKEN" in env) {
    fail(`base config must not contain env.ANTHROPIC_AUTH_TOKEN: ${paths.baseFile}`);
  }
  if ("ANTHROPIC_BASE_URL" in env) {
    fail(`base config must not contain env.ANTHROPIC_BASE_URL: ${paths.baseFile}`);
  }
}

function validateMergedConfig(merged: JsonObject, profileName: string, paths: Paths) {
  const env = getObject(merged.env);
  if (!env) {
    fail(`merged config has no env for profile ${profileName}`);
  }
  const baseUrl = getString(env.ANTHROPIC_BASE_URL);
  const authToken = getString(env.ANTHROPIC_AUTH_TOKEN);
  if (!baseUrl) {
    fail(`profile ${profileName} is missing env.ANTHROPIC_BASE_URL (${paths.profilesDir})`);
  }
  if (!authToken) {
    fail(`profile ${profileName} is missing env.ANTHROPIC_AUTH_TOKEN (${paths.profilesDir})`);
  }
}

function detectActiveProfile(paths: Paths, profiles: Profile[]): string | null {
  const state = loadOptionalJsonFile(paths.stateFile);
  if (state && typeof state.activeProfile === "string") {
    return state.activeProfile;
  }
  if (!existsSync(paths.targetFile)) {
    return null;
  }
  const current = loadJsonFile(paths.targetFile);
  const base = loadOptionalJsonFile(paths.baseFile);
  if (!base) {
    return null;
  }
  for (const profile of profiles) {
    const merged = deepMerge(base, profile.data);
    applyBaseOverrides(base, merged);
    if (deepEqual(current, merged)) {
      return profile.name;
    }
  }
  return null;
}

function detectActiveProfileByCompare(current: JsonObject, base: JsonObject, profiles: Profile[]): string | null {
  for (const profile of profiles) {
    const merged = deepMerge(base, profile.data);
    applyBaseOverrides(base, merged);
    if (deepEqual(current, merged)) {
      return profile.name;
    }
  }
  return null;
}

function applyBaseOverrides(base: JsonObject, merged: JsonObject) {
  // Profiles should not override Claude Code's model selection. Keep it stable in base.
  if (typeof base.model === "string" && base.model) {
    merged.model = base.model;
  }
}

type Profile = { name: string; file: string; data: JsonObject };

function loadProfiles(paths: Paths): Profile[] {
  if (!existsSync(paths.profilesDir)) {
    return [];
  }
  const glob = new Bun.Glob("*.json");
  const items: Profile[] = [];
  for (const file of glob.scanSync(paths.profilesDir)) {
    const fullPath = join(paths.profilesDir, file);
    items.push({ name: basename(file, ".json"), file: fullPath, data: loadJsonFile(fullPath) });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

function printProfileChoices(profiles: Profile[], active: string | null) {
  for (const [index, profile] of profiles.entries()) {
    const marker = profile.name === active ? "*" : " ";
    console.log(`${marker} ${index + 1}. ${profile.name}`);
  }
}

function resolveProfileSelection(profiles: Profile[], input: string): Profile | undefined {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    return profiles[index];
  }
  return profiles.find((item) => item.name === trimmed);
}

function slugifyForFileName(input: string): string {
  // Keep the raw model value in config, but create a safe alias for the filename.
  // Example: "claude/opus:latest" -> "claude-opus-latest"
  const cleaned = input
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!cleaned) {
    fail("model name cannot be converted into a safe filename alias");
  }
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

function atomicWriteJson(filePath: string, data: JsonValue) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tempFile = join(dir, `.${basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tempFile, filePath);
}

function loadJsonFile(filePath: string): JsonObject {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as JsonValue;
    const object = getObject(parsed);
    if (!object) {
      fail(`expected JSON object: ${filePath}`);
    }
    return object;
  } catch (error) {
    fail(`failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadOptionalJsonFile(filePath: string): JsonObject | null {
  if (!existsSync(filePath)) {
    return null;
  }
  return loadJsonFile(filePath);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg.startsWith("--")) {
      const parts = arg.slice(2).split("=", 2);
      const key = parts[0];
      const inlineValue = parts[1];
      if (!key) {
        continue;
      }
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { flags, positionals };
}

function deepMerge(base: JsonObject, overlay: JsonObject): JsonObject {
  const result: JsonObject = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
      result[key] = deepMerge(baseValue, overlayValue);
      continue;
    }
    result[key] = clone(overlayValue);
  }
  return result;
}

function clone<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as T;
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = clone(item);
    }
    return out as T;
  }
  return value;
}

function redactSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? "<redacted>" : redactSecrets(item);
    }
    return out;
  }
  return value;
}

function deepEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index] ?? null, right[index] ?? null)) {
        return false;
      }
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!(key in right)) {
        return false;
      }
      if (!deepEqual(left[key] ?? null, right[key] ?? null)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function getNested(value: JsonValue, keys: string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of keys) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function getObject(value: JsonValue | undefined): JsonObject | null {
  return isPlainObject(value) ? value : null;
}

function getString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp() {
  console.log(`${CLI_NAME} ${VERSION}

Usage:
  ${CLI_NAME} init [--from <file>] [--force]
  ${CLI_NAME} new [--name <name>] [--base-url <url>] [--key <token>] [--model <provider-model>] [--force]
  ${CLI_NAME} list [--json]
  ${CLI_NAME} current [--json]
  ${CLI_NAME} use [profile|number] [--dry-run]
  ${CLI_NAME} rollback
  ${CLI_NAME} dump <profile> [--raw]
  ${CLI_NAME} validate [--json]
  ${CLI_NAME} paths

Defaults:
  config dir: ~/.claude
  base file: ~/.claude/settings.base.json
  profiles:  ~/.claude/profiles/*.json
  target:    ~/.claude/settings.json

  Notes:
  - base file should contain shared config only (no baseurl/token).
  - provider-specific ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN belong in profile files.
  - new creates ~/.claude/profiles/<name>.json interactively if flags are omitted.
  - new --model writes env.ANTHROPIC_MODEL and env.ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL (provider-side model routing).
  - rollback swaps settings.json and settings.switcher.backup.json.
  - list shows numbered profiles; use accepts either a profile name or a number.
  - use writes ~/.claude/settings.json atomically and saves the previous file to settings.switcher.backup.json.
`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

main();
