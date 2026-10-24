// Compatibility shim: Instagram sharing now lives in server/share/.
export {
  BLOCKED_MESSAGE,
  buildArgs,
  classifyError,
  type Downloaded,
  type DownloadedItem,
  downloadInstagram,
  extractInstagramUrl,
  FETCH_HINT,
  type FetchedPost,
  fetchPost,
  type InstagramLink,
  MAX_ITEMS,
  MAX_TOTAL_BYTES,
  ShareError,
} from "./share/instagram.ts";
