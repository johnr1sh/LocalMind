/**
 * Exposes deployment metadata only; no user or model data is returned.
 * Vercel injects these values for each deployment automatically.
 */
module.exports = function handler(_request, response) {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || 'local';
  const shortCommit = commit === 'local' ? 'local' : commit.slice(0, 12);

  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  response.setHeader('CDN-Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');

  return response.status(200).json({
    commit,
    version: shortCommit,
    environment: process.env.VERCEL_ENV || 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF || 'local',
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    createdAt: process.env.VERCEL_GIT_COMMIT_SHA ? null : new Date().toISOString(),
  });
}
