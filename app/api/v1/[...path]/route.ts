import { apiError } from "@/server/api/v1";

// Any /api/v1 path without an endpoint answers with the API's JSON error shape
// instead of the app's HTML 404 page. Serves no data, so it needs no key.
function notFound(req: Request): Response {
  return apiError(404, `No endpoint at ${req.method} ${new URL(req.url).pathname}`);
}

export {
  notFound as GET,
  notFound as POST,
  notFound as PUT,
  notFound as PATCH,
  notFound as DELETE,
};
