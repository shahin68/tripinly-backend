/** Where a user's exports live in the bucket; deletion removes the whole prefix. */
export const exportPrefix = (userId: string) => `exports/${userId}/`;

export const exportKey = (userId: string, exportId: string) =>
  `${exportPrefix(userId)}${exportId}.zip`;
