// Only invoked explicitly by security-http.test.js, never by production startup.
export async function resolve(specifier, context, next) {
  if (specifier === "pg") return {url: new URL("./security-fixture-pg.mjs", import.meta.url).href, shortCircuit:true};
  return next(specifier, context);
}
