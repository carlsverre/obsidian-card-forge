import "obsidian";

declare module "obsidian" {
  interface Vault {
    getConfig<T = unknown>(key: string): T | undefined;
  }

  interface App {
    internalPlugins: PluginManager;
  }

  interface PluginManager {
    getPluginById(id: string): any;
  }
}
