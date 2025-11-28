import "obsidian";

declare module "obsidian" {
  interface Vault {
    getConfig<T = unknown>(key: string): T | undefined;
  }

  interface App {
    internalPlugins: PluginManager;
  }

  interface InternalPlugin {
    enabled: boolean;
    instance: {
      options: {
        folder: string;
      };
    };
  }

  interface PluginManager {
    getPluginById(id: string): InternalPlugin | undefined;
  }
}
