import { createRequire as __WEBPACK_EXTERNAL_createRequire } from "module";
/******/ var __webpack_modules__ = ({

/***/ 24:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:fs");

/***/ }),

/***/ 136:
/***/ ((module) => {

module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("node:url");

/***/ }),

/***/ 643:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __nccwpck_require__) => {

/* harmony export */ __nccwpck_require__.d(__webpack_exports__, {
/* harmony export */   h: () => (/* binding */ createLogger)
/* harmony export */ });
/* harmony import */ var node_fs__WEBPACK_IMPORTED_MODULE_0__ = __nccwpck_require__(24);


// Shapes of credentials we never want in a log line, even if they were not
// registered as secrets (for example a refreshed token echoed in an error).
const TOKEN_PATTERNS = [
  /\bIG[A-Za-z0-9_-]{20,}/g, // Instagram user access tokens
  /\bEA[A-Za-z0-9]{20,}/g, // Facebook-style access tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
];
const ACCESS_TOKEN_PARAM = /(access_token=)[^&\s"']+/gi;
const REDACTED = '***';

// Workflow commands treat these characters specially; escape them so a
// caption or error message cannot inject a command of its own.
function escapeCommandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function createLogger({
  stdout = process.stdout,
  stderr = process.stderr,
  summaryPath = null,
  mask = false,
} = {}) {
  const secrets = new Set();

  function redact(value) {
    let text = String(value);
    // Longest first, so a secret that contains another is fully replaced.
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join(REDACTED);
    }
    text = text.replace(ACCESS_TOKEN_PARAM, `$1${REDACTED}`);
    for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, REDACTED);
    return text;
  }

  function annotate(kind, message) {
    stdout.write(`::${kind}::${escapeCommandData(redact(message))}\n`);
  }

  return {
    redact,
    addSecret(secret) {
      if (typeof secret !== 'string' || secret.length === 0) return;
      secrets.add(secret);
      // Only on a real runner: the mask command must carry the raw value.
      if (mask) stdout.write(`::add-mask::${secret}\n`);
    },
    info(message) {
      stdout.write(`${redact(message)}\n`);
    },
    notice: (message) => annotate('notice', message),
    warning: (message) => annotate('warning', message),
    error(message) {
      annotate('error', message);
      stderr.write(`${redact(message)}\n`);
    },
    summary(markdown) {
      if (summaryPath) (0,node_fs__WEBPACK_IMPORTED_MODULE_0__.appendFileSync)(summaryPath, `${redact(markdown)}\n`);
    },
  };
}


/***/ }),

/***/ 525:
/***/ ((__webpack_module__, __webpack_exports__, __nccwpck_require__) => {

__nccwpck_require__.a(__webpack_module__, async (__webpack_handle_async_dependencies__, __webpack_async_result__) => { try {
/* harmony export */ __nccwpck_require__.d(__webpack_exports__, {
/* harmony export */   Ko: () => (/* binding */ readInputs),
/* harmony export */   eF: () => (/* binding */ run),
/* harmony export */   iW: () => (/* binding */ main),
/* harmony export */   yo: () => (/* binding */ UserError)
/* harmony export */ });
/* harmony import */ var node_fs__WEBPACK_IMPORTED_MODULE_0__ = __nccwpck_require__(24);
/* harmony import */ var node_url__WEBPACK_IMPORTED_MODULE_1__ = __nccwpck_require__(136);
/* harmony import */ var _log_js__WEBPACK_IMPORTED_MODULE_2__ = __nccwpck_require__(643);
/* harmony import */ var _providers_index_js__WEBPACK_IMPORTED_MODULE_3__ = __nccwpck_require__(45);





// Thrown for problems the user can fix (bad input, bad config). main() prints
// the message alone, without a stack trace.
class UserError extends Error {}

function getInput(env, name, { required = false, fallback = '' } = {}) {
  const value = (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  if (required && value === '') throw new UserError(`Input "${name}" is required.`);
  return value === '' ? fallback : value;
}

function parseBoolean(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new UserError(`Input "${name}" must be "true" or "false", got "${value}".`);
}

function readInputs(env) {
  const inputs = {
    provider: getInput(env, 'provider', { required: true }),
    token: getInput(env, 'token', { required: true }),
    config: getInput(env, 'config', { fallback: 'simple-media.yml' }),
    dryRun: parseBoolean('dry_run', getInput(env, 'dry_run', { fallback: 'false' })),
    secretsToken: getInput(env, 'secrets_token') || null,
    fixtureDir: getInput(env, 'fixture_dir') || null,
  };
  if (!(0,_providers_index_js__WEBPACK_IMPORTED_MODULE_3__/* .providerNames */ .e)().includes(inputs.provider)) {
    throw new UserError(
      `Input "provider" must be one of: ${(0,_providers_index_js__WEBPACK_IMPORTED_MODULE_3__/* .providerNames */ .e)().join(', ')}. Got "${inputs.provider}".`,
    );
  }
  return inputs;
}

function setOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) (0,node_fs__WEBPACK_IMPORTED_MODULE_0__.appendFileSync)(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function run({ env = process.env, logger } = {}) {
  const inputs = readInputs(env);
  logger.addSecret(inputs.token);
  if (inputs.secretsToken) logger.addSecret(inputs.secretsToken);

  const result = { fetched: 0, added: 0, removed: 0, kept: 0, changed: false };

  logger.info(
    `simple-media-client: provider=${inputs.provider} dry_run=${inputs.dryRun}` +
      (inputs.fixtureDir ? ' fixtures=on' : ''),
  );
  logger.notice(
    `${inputs.provider}: fetched ${result.fetched}, +${result.added} new, ` +
      `-${result.removed} removed, ${result.kept} kept`,
  );
  logger.summary(
    [
      '### simple-media-client',
      '',
      '| Provider | Dry run | Fetched | New | Removed | Kept |',
      '|---|---|---|---|---|---|',
      `| ${inputs.provider} | ${inputs.dryRun} | ${result.fetched} | ${result.added} | ${result.removed} | ${result.kept} |`,
    ].join('\n'),
  );
  setOutput(env, 'changed', String(result.changed));
  return result;
}

async function main(env = process.env) {
  const logger = (0,_log_js__WEBPACK_IMPORTED_MODULE_2__/* .createLogger */ .h)({
    summaryPath: env.GITHUB_STEP_SUMMARY || null,
    mask: env.GITHUB_ACTIONS === 'true',
  });
  try {
    await run({ env, logger });
  } catch (err) {
    // UserErrors carry a message written for the reader; anything else is a
    // bug, but we still avoid dumping a stack that could hold request data.
    const message = err instanceof UserError ? err.message : `Unexpected error: ${err.message}`;
    logger.error(message);
    process.exitCode = 1;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return (0,node_fs__WEBPACK_IMPORTED_MODULE_0__.realpathSync)(process.argv[1]) === (0,node_url__WEBPACK_IMPORTED_MODULE_1__.fileURLToPath)(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) await main();

__webpack_async_result__();
} catch(e) { __webpack_async_result__(e); } }, 1);

/***/ }),

/***/ 45:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __nccwpck_require__) => {


// EXPORTS
__nccwpck_require__.d(__webpack_exports__, {
  e: () => (/* binding */ providerNames)
});

// UNUSED EXPORTS: getProvider

// NAMESPACE OBJECT: ./src/providers/instagram.js
var instagram_namespaceObject = {};
__nccwpck_require__.r(instagram_namespaceObject);
__nccwpck_require__.d(instagram_namespaceObject, {
  name: () => (instagram_name)
});

;// CONCATENATED MODULE: ./src/providers/instagram.js
// Instagram adapter (Instagram API with Instagram Login). Implemented in M3.
const instagram_name = 'instagram';

;// CONCATENATED MODULE: ./src/providers/index.js


// Registry: provider name -> adapter. A second provider is one new module
// plus one line here.
const adapters = { instagram: instagram_namespaceObject };

function providerNames() {
  return Object.keys(adapters);
}

function getProvider(name) {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`Unknown provider "${name}".`);
  return adapter;
}


/***/ })

/******/ });
/************************************************************************/
/******/ // The module cache
/******/ var __webpack_module_cache__ = {};
/******/ 
/******/ // The require function
/******/ function __nccwpck_require__(moduleId) {
/******/ 	// Check if module is in cache
/******/ 	var cachedModule = __webpack_module_cache__[moduleId];
/******/ 	if (cachedModule !== undefined) {
/******/ 		return cachedModule.exports;
/******/ 	}
/******/ 	// Create a new module (and put it into the cache)
/******/ 	var module = __webpack_module_cache__[moduleId] = {
/******/ 		// no module.id needed
/******/ 		// no module.loaded needed
/******/ 		exports: {}
/******/ 	};
/******/ 
/******/ 	// Execute the module function
/******/ 	var threw = true;
/******/ 	try {
/******/ 		__webpack_modules__[moduleId](module, module.exports, __nccwpck_require__);
/******/ 		threw = false;
/******/ 	} finally {
/******/ 		if(threw) delete __webpack_module_cache__[moduleId];
/******/ 	}
/******/ 
/******/ 	// Return the exports of the module
/******/ 	return module.exports;
/******/ }
/******/ 
/************************************************************************/
/******/ /* webpack/runtime/asset-relocator-loader */
/******/ if (typeof __nccwpck_require__ !== 'undefined') __nccwpck_require__.ab = decodeURIComponent(new URL('.', import.meta.url).pathname).slice(import.meta.url.match(/^file:\/\/\/\w:/) ? 1 : 0, -1) + "/";
/******/ 
/******/ /* webpack/runtime/async module */
/******/ (() => {
/******/ 	var webpackQueues = typeof Symbol === "function" ? Symbol("webpack queues") : "__webpack_queues__";
/******/ 	var webpackExports = typeof Symbol === "function" ? Symbol("webpack exports") : "__webpack_exports__";
/******/ 	var webpackError = typeof Symbol === "function" ? Symbol("webpack error") : "__webpack_error__";
/******/ 	var resolveQueue = (queue) => {
/******/ 		if(queue && queue.d < 1) {
/******/ 			queue.d = 1;
/******/ 			queue.forEach((fn) => (fn.r--));
/******/ 			queue.forEach((fn) => (fn.r-- ? fn.r++ : fn()));
/******/ 		}
/******/ 	}
/******/ 	var wrapDeps = (deps) => (deps.map((dep) => {
/******/ 		if(dep !== null && typeof dep === "object") {
/******/ 			if(dep[webpackQueues]) return dep;
/******/ 			if(dep.then) {
/******/ 				var queue = [];
/******/ 				queue.d = 0;
/******/ 				dep.then((r) => {
/******/ 					obj[webpackExports] = r;
/******/ 					resolveQueue(queue);
/******/ 				}, (e) => {
/******/ 					obj[webpackError] = e;
/******/ 					resolveQueue(queue);
/******/ 				});
/******/ 				var obj = {};
/******/ 				obj[webpackQueues] = (fn) => (fn(queue));
/******/ 				return obj;
/******/ 			}
/******/ 		}
/******/ 		var ret = {};
/******/ 		ret[webpackQueues] = x => {};
/******/ 		ret[webpackExports] = dep;
/******/ 		return ret;
/******/ 	}));
/******/ 	__nccwpck_require__.a = (module, body, hasAwait) => {
/******/ 		var queue;
/******/ 		hasAwait && ((queue = []).d = -1);
/******/ 		var depQueues = new Set();
/******/ 		var exports = module.exports;
/******/ 		var currentDeps;
/******/ 		var outerResolve;
/******/ 		var reject;
/******/ 		var promise = new Promise((resolve, rej) => {
/******/ 			reject = rej;
/******/ 			outerResolve = resolve;
/******/ 		});
/******/ 		promise[webpackExports] = exports;
/******/ 		promise[webpackQueues] = (fn) => (queue && fn(queue), depQueues.forEach(fn), promise["catch"](x => {}));
/******/ 		module.exports = promise;
/******/ 		body((deps) => {
/******/ 			currentDeps = wrapDeps(deps);
/******/ 			var fn;
/******/ 			var getResult = () => (currentDeps.map((d) => {
/******/ 				if(d[webpackError]) throw d[webpackError];
/******/ 				return d[webpackExports];
/******/ 			}))
/******/ 			var promise = new Promise((resolve) => {
/******/ 				fn = () => (resolve(getResult));
/******/ 				fn.r = 0;
/******/ 				var fnQueue = (q) => (q !== queue && !depQueues.has(q) && (depQueues.add(q), q && !q.d && (fn.r++, q.push(fn))));
/******/ 				currentDeps.map((dep) => (dep[webpackQueues](fnQueue)));
/******/ 			});
/******/ 			return fn.r ? promise : getResult();
/******/ 		}, (err) => ((err ? reject(promise[webpackError] = err) : outerResolve(exports)), resolveQueue(queue)));
/******/ 		queue && queue.d < 0 && (queue.d = 0);
/******/ 	};
/******/ })();
/******/ 
/******/ /* webpack/runtime/define property getters */
/******/ (() => {
/******/ 	// define getter functions for harmony exports
/******/ 	__nccwpck_require__.d = (exports, definition) => {
/******/ 		for(var key in definition) {
/******/ 			if(__nccwpck_require__.o(definition, key) && !__nccwpck_require__.o(exports, key)) {
/******/ 				Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 			}
/******/ 		}
/******/ 	};
/******/ })();
/******/ 
/******/ /* webpack/runtime/hasOwnProperty shorthand */
/******/ (() => {
/******/ 	__nccwpck_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ })();
/******/ 
/******/ /* webpack/runtime/make namespace object */
/******/ (() => {
/******/ 	// define __esModule on exports
/******/ 	__nccwpck_require__.r = (exports) => {
/******/ 		if(typeof Symbol !== 'undefined' && Symbol.toStringTag) {
/******/ 			Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
/******/ 		}
/******/ 		Object.defineProperty(exports, '__esModule', { value: true });
/******/ 	};
/******/ })();
/******/ 
/************************************************************************/
/******/ 
/******/ // startup
/******/ // Load entry module and return exports
/******/ // This entry module used 'module' so it can't be inlined
/******/ var __webpack_exports__ = __nccwpck_require__(525);
/******/ __webpack_exports__ = await __webpack_exports__;
/******/ var __webpack_exports__UserError = __webpack_exports__.yo;
/******/ var __webpack_exports__main = __webpack_exports__.iW;
/******/ var __webpack_exports__readInputs = __webpack_exports__.Ko;
/******/ var __webpack_exports__run = __webpack_exports__.eF;
/******/ export { __webpack_exports__UserError as UserError, __webpack_exports__main as main, __webpack_exports__readInputs as readInputs, __webpack_exports__run as run };
/******/ 
