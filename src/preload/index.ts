import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('stash', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
})
