/**
 * A short reason for a failed download or command, for logs and run rows.
 * fetch only says "fetch failed"; the reason (DNS, refused, reset, TLS) is in
 * its cause. A failed command's message is mostly the command line, which
 * pushes its stderr past what a run row keeps: name the tool, how it ended
 * (exit code or the signal that killed it, e.g. SIGKILL when out of memory)
 * and stderr.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const failed = error as Error & {
    cmd?: string;
    code?: number | string;
    signal?: string | null;
    killed?: boolean;
    stderr?: string;
  };
  if (!failed.cmd) {
    const cause = error.cause instanceof Error ? error.cause : undefined;
    if (!cause) return error.message;
    const code = (cause as Error & { code?: string }).code;
    const reason =
      code && !cause.message.includes(code)
        ? `${code} ${cause.message}`
        : cause.message;
    return `${error.message}: ${reason}`;
  }
  const tool = failed.cmd.split(' ').slice(0, 2).join(' ');
  const ending = failed.signal
    ? `killed by ${failed.signal}`
    : `exit code ${failed.code}`;
  const stderr = failed.stderr?.trim();
  return `${tool} failed (${ending})${stderr ? `: ${stderr}` : ''}`;
}
