// Hash a new instructor (or reviewer) password.
//
//   pnpm change-admin-password               print an ADMIN_PASSWORD_HASH line
//                                            for .env.local (the default)
//   pnpm change-admin-password --reviewer    the same for REVIEWER_PASSWORD_HASH
//   pnpm change-admin-password --vercel      push the hash to the linked Vercel
//                                            project's production environment
//
// The password is read from a hidden prompt, or from stdin when stdin is not
// a terminal (one line, no confirmation). It is never an argument, so it
// never reaches the process list or shell history. It must be at least 12
// characters. --vercel only sets the environment variable; it does not
// deploy. Redeploy production afterwards for the new hash to take effect.

import { hash } from "bcryptjs";
import { spawnSync } from "node:child_process";
import { envLocalLine, parsePasswordArgs, passwordProblem } from "./password-hash";

async function readLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  if (!process.stdin.isTTY) {
    let buf = "";
    for await (const chunk of process.stdin) buf += String(chunk);
    process.stderr.write("\n");
    return buf.split(/\r?\n/)[0] ?? "";
  }
  return new Promise((resolve, reject) => {
    let pwd = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const done = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (key: string) => {
      if (key === "\r" || key === "\n" || key === "\u0004") {
        done();
        resolve(pwd);
      } else if (key === "\u0003") {
        done();
        reject(new Error("Cancelled."));
      } else if (key === "\u007f" || key === "\b") {
        pwd = pwd.slice(0, -1);
      } else {
        pwd += key;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const args = parsePasswordArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    process.exit(2);
  }
  const who = args.target === "REVIEWER_PASSWORD_HASH" ? "reviewer" : "instructor";

  const pwd = await readLine(`New ${who} password: `);
  const problem = passwordProblem(pwd);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const confirm = await readLine("Confirm password: ");
    if (confirm !== pwd) {
      console.error("The passwords do not match.");
      process.exit(1);
    }
  }

  const h = await hash(pwd, 12);

  if (!args.vercel) {
    console.error(`Add this line to .env.local (the $ signs are escaped for dotenv):`);
    console.log(envLocalLine(args.target, h));
    return;
  }

  // The hash goes to the Vercel CLI on stdin, not as an argument.
  spawnSync("vercel", ["env", "rm", args.target, "production", "--yes"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const add = spawnSync("vercel", ["env", "add", args.target, "production"], {
    input: h,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (add.status !== 0) {
    console.error(`Could not set ${args.target} on Vercel. Is this directory linked (vercel link)?`);
    process.exit(1);
  }
  console.error(
    `${args.target} is set for production. Redeploy production for it to take effect; this script does not deploy.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
