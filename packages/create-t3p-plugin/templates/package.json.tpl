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
    "@t3p/api": "*",
    "@t3p/plugin-build": "*",
    "typescript": "^5.9.3"
  }
}
