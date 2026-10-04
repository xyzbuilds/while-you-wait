export const QUEUE_JSON = JSON.stringify({
  data: {
    review: { nodes: [{ number: 41, title: 'Add retry to the upload client', url: 'https://github.com/acme/api/pull/41', isDraft: false, updatedAt: '2026-10-03T10:00:00Z', additions: 120, deletions: 30, changedFiles: 4, author: { login: 'dana' }, repository: { nameWithOwner: 'acme/api' } }] },
    mine: {
      nodes: [
        { number: 3, title: 'Draft: move config to env', url: 'https://github.com/acme/web/pull/3', isDraft: true, updatedAt: '2026-10-01T10:00:00Z', reviewDecision: null, comments: { totalCount: 2 }, reviews: { totalCount: 0 }, repository: { nameWithOwner: 'acme/web' }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } },
        { number: 7, title: 'Fix login redirect', url: 'https://github.com/acme/web/pull/7', isDraft: false, updatedAt: '2026-10-03T09:00:00Z', reviewDecision: 'REVIEW_REQUIRED', comments: { totalCount: 1 }, reviews: { totalCount: 1 }, repository: { nameWithOwner: 'acme/web' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
      ],
    },
    issues: { nodes: [{ number: 12, title: 'Upload fails on large files', url: 'https://github.com/acme/api/issues/12', updatedAt: '2026-10-02T10:00:00Z', repository: { nameWithOwner: 'acme/api' } }] },
  },
})

export const DIFF = `diff --git a/src/upload.ts b/src/upload.ts
index 1111111..2222222 100644
--- a/src/upload.ts
+++ b/src/upload.ts
@@ -10,3 +10,5 @@ export async function upload(file: File) {
   const body = await file.arrayBuffer()
-  return post(body)
+  for (let i = 0; i < 3; i++) {
+    try { return await post(body) } catch {}
+  }
 }
diff --git a/assets/logo.png b/assets/logo.png
index 3333333..4444444 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`
