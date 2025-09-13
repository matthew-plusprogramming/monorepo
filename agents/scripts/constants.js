// Shared constants used by agent scripts.
// Adjust these for your project layout when porting to another repo.

export const MEMORY_OVERVIEW = 'agents/memory-bank.md';
export const MEMORY_DIR = 'agents/memory-bank';
export const WORKFLOWS_DIR = 'agents/workflows';

// Optional convenience: directories containing docs to scan
export const DOC_DIRS = ['agents/memory-bank', 'agents/workflows'];

// Inline code path prefixes to validate when found inside markdown backticks.
// i.e. these should be the paths where all your code is located (e.g. 'src/')
export const PATH_PREFIXES = ['apps/', 'packages/', 'cdk/', 'agents/'];

// Directories considered for drift checks between the stamped SHA and HEAD.
// i.e. these are probably the same as above (e.g. 'src/', 'packages/')
export const DRIFT_TRACKED_DIRS = ['apps', 'cdk', 'packages'];

// Root-level files that may be referenced inside memory bank markdown.
export const ROOT_BASENAMES = new Set([
  'README.md',
  'package.json',
  'package-lock.json',
  'turbo.json',
  'agents/memory-bank.md',
  'monorepo.code-workspace',
]);

// Regex used to extract inline code tokens from markdown.
export const CODE_SPAN_REGEX = /`([^`]+)`/g;

// Schemes to ignore when extracting markdown links
export const LINK_IGNORE_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

// Regexes used by validators (centralized)
export const FENCED_BACKTICK_BLOCK_REGEX = /```[\s\S]*?```/g;
export const FENCED_TILDE_BLOCK_REGEX = /~~~[\s\S]*?~~~/g;
// Inline markdown links and images: optional leading ! for images
// Robust inline markdown link/image regex source and factory
export const INLINE_LINK_OR_IMAGE_RE_SOURCE = String.raw`!?\[[^\]]*]\(\s*(<[^>]*>|[^()\s]+(?:\([^)]*\)[^()\s]*)*)(?:\s+["'(][^"')]*["')])?\s*\)`;
export const makeInlineLinkOrImageRe = () => new RegExp(INLINE_LINK_OR_IMAGE_RE_SOURCE, 'g');
// Reference-style link definition at start of line
export const REF_DEFINITION_REGEX = /^\s*\[[^\]]+\]:\s*(\S+)/;
// Plain-text agents/ path references
export const PLAIN_AGENTS_REF_REGEX = /agents\/[A-Za-z0-9._\/-]+/g;
// Detect URL scheme prefixes
export const SCHEME_PREFIX_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// Trim common trailing punctuation adjacent to paths
export const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)>\]]+$/g;