/** Conservative first-release bounds that keep every successful result under the Agent limit. */
export const GITHUB_MAX_PAGE_SIZE = 5;
export const GITHUB_MAX_TEXT_BYTES = 512;
export const GITHUB_MAX_PREVIEW_BYTES = 1_024;
export const GITHUB_MAX_RECORD_ARRAY_ITEMS = 10;
export const GITHUB_MAX_CHECK_ITEMS = 20;
/** Leaves 8 KiB for the invocation transcript/protocol around a Provider result. */
export const GITHUB_MAX_RESULT_BYTES = 122_880;
