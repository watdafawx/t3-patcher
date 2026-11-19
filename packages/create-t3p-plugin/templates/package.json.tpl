{
  "name": "__ID__",
  "version": "__VERSION__",
  "private": true,
  "type": "module",
  "description": __NAME_JSON__,
  "scripts": {
    "build": "t3p-plugin-build",
    "dev": "t3p-plugin-build --watch",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@t3p/api": "__DEP_RANGE__",
    "@t3p/plugin-build": "__DEP_RANGE__",
    "typescript": "^5.9.3"
  }
}
