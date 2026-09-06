const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function parseEnvFile(content) {
  const parsed = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function run() {
  const [, , envFileArg, targetScriptArg, ...restArgs] = process.argv;
  const envFile = envFileArg || ".env.live.example";
  const targetScript = targetScriptArg || "dev:all";
  const isDryRun = restArgs.includes("--dry-run");
  const forwardArgs = restArgs.filter((value) => value !== "--dry-run");

  const resolvedEnvPath = path.resolve(process.cwd(), envFile);
  if (!fs.existsSync(resolvedEnvPath)) {
    console.error(`Environment file not found: ${resolvedEnvPath}`);
    process.exit(1);
  }

  const envContent = fs.readFileSync(resolvedEnvPath, "utf8");
  const loadedEnv = parseEnvFile(envContent);
  const configKeys = new Set(Object.keys(loadedEnv));
  for (const profileFile of [".env", ".env.sandbox", ".env.live"]) {
    const profilePath = path.resolve(process.cwd(), profileFile);
    if (fs.existsSync(profilePath)) {
      for (const key of Object.keys(parseEnvFile(fs.readFileSync(profilePath, "utf8")))) {
        configKeys.add(key);
      }
    }
  }

  const inheritedEnv = { ...process.env };
  for (const key of configKeys) {
    delete inheritedEnv[key];
  }
  const env = {
    ...inheritedEnv,
    ...loadedEnv,
    ENV_FILE: resolvedEnvPath,
    DOTENV_CONFIG_PATH: resolvedEnvPath
  };

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = ["run", targetScript];
  if (forwardArgs.length > 0) {
    npmArgs.push("--", ...forwardArgs);
  }

  if (isDryRun) {
    console.log(`Loaded ${Object.keys(loadedEnv).length} env vars from ${envFile}`);
    console.log(`Resolved ENV_FILE: ${resolvedEnvPath}`);
    console.log(`Command: ${npmCommand} ${npmArgs.join(" ")}`);
    process.exit(0);
  }

  const child = spawn(npmCommand, npmArgs, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32"
  });

  child.on("error", (error) => {
    console.error(`Failed to start command: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

run();
