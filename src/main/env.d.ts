declare module 'ffprobe-static' {
  const ffprobe: { path: string }
  export default ffprobe
}

interface ImportMetaEnv {
  /** Address of the Telegram relay, from .env.local at build time. */
  readonly MAIN_VITE_RELAY_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
