/** `@handle`s in a comment body: a username after a start, space or punctuation other than `.` and `_`. */
const MENTION = /(?<![\w.@])@([a-z0-9_.]{3,30})/gi;

/** The usernames a body mentions, lower-cased, trailing dots dropped ("@anna." ends a sentence). */
export function mentionedUsernames(body: string): string[] {
  const names = [...body.matchAll(MENTION)].map((match) =>
    match[1].toLowerCase().replace(/\.+$/, ''),
  );
  return [...new Set(names)];
}
