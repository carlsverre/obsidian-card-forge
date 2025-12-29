import {
  App,
  Component,
  ItemView,
  MarkdownFileInfo,
  MarkdownRenderer,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { toBlob } from "html-to-image";

type Maybe<T> = T | null | undefined;

interface CardForgeSettings {
  cardTag: string;
}

const DEFAULT_SETTINGS: CardForgeSettings = {
  cardTag: "card",
};

export const VIEW_TYPE_PREVIEW = "card-forge-preview";

export const FRONTMATTER_TYPE = "card-type";
export const FRONTMATTER_TITLE = "card-title";
export const FRONTMATTER_IMAGE = "card-image";
export const FRONTMATTER_NUMBER = "card-number";

export default class CardForgePlugin extends Plugin {
  settings: CardForgeSettings;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_PREVIEW, (leaf) => new CardForgePreview(leaf));

    this.addCommand({
      id: "open-preview",
      name: "Open preview",
      callback: async () => {
        await this.activatePreview();
      },
    });

    this.addCommand({
      id: "render-cards",
      name: "Render tagged cards",
      callback: async () => {
        await this.renderTaggedCards();
      },
    });

    this.addCommand({
      id: "number-cards",
      name: "Number cards",
      callback: async () => {
        await this.numberCards();
      },
    });

    this.addSettingTab(new CardForgeSettingsTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<CardForgeSettings> | null,
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activatePreview() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_PREVIEW);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_PREVIEW, active: true });
      }
    }

    if (!leaf) {
      new Notice("Failed to activate card preview");
      return;
    }

    await workspace.revealLeaf(leaf);
  }

  getAllCards(): TFile[] {
    let tag = this.settings.cardTag;
    if (!tag) {
      tag = DEFAULT_SETTINGS.cardTag;
    }

    const templatesPlugin = this.app.internalPlugins.getPluginById("templates");
    let templateFilter = undefined;
    if (templatesPlugin?.enabled) {
      const templateFolder = templatesPlugin.instance.options.folder;
      templateFilter = (filename: string) =>
        filename.startsWith(templateFolder);
    }

    return this.app.vault.getMarkdownFiles().filter((file) => {
      if (templateFilter && templateFilter(file.path)) {
        return false;
      }
      const meta = this.app.metadataCache.getFileCache(file);
      const tags = meta?.frontmatter?.tags as string[] | undefined;
      return tags?.some((t) => t === tag);
    });
  }

  async renderTaggedCards() {
    const files = this.getAllCards();
    let note = new Notice("Rendering cards...", 0);
    try {
      for (let file of files) {
        note.setMessage(`Rendering card for ${file.basename}`);
        await renderCardToFile(this.app, file, this);
      }
    } finally {
      note.hide();
    }
  }

  async numberCards() {
    const files = this.getAllCards();
    let nextNum = 1;

    // update nextNum to be the largest existing card number
    for (const file of files) {
      const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const cardNum = meta?.[FRONTMATTER_NUMBER] as number | undefined;
      if (cardNum !== undefined) {
        nextNum = Math.max(nextNum, cardNum + 1);
      }
    }

    for (const file of files) {
      await this.app.fileManager.processFrontMatter(
        file,
        (meta: Record<string, unknown>) => {
          if (meta[FRONTMATTER_NUMBER] === undefined) {
            meta[FRONTMATTER_NUMBER] = nextNum++;
          }
        },
      );
    }
  }
}

export class CardForgePreview extends ItemView {
  active: boolean = false;
  lastEditor: MarkdownFileInfo | null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "eye";
  }

  getViewType() {
    return VIEW_TYPE_PREVIEW;
  }

  getDisplayText() {
    return "Card forge preview";
  }

  async onOpen() {
    this.active = true;
    this.contentEl.classList.add("card-forge-preview");
    this.contentEl.empty();

    this.registerDomEvent(this.containerEl, "contextmenu", (event) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Copy to clipboard")
          .setIcon("copy")
          .onClick(() => this.renderToClipboard()),
      );
      menu.addItem((item) =>
        item
          .setTitle("Render to file")
          .setIcon("save")
          .onClick(() => this.renderToFile()),
      );
      menu.showAtMouseEvent(event);
    });

    this.registerEvent(
      this.app.workspace.on("file-open", () => this.render()),
    );
    this.registerEvent(this.app.vault.on("modify", () => this.render()));
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.render()),
    );
    await this.render();
  }

  async render() {
    if (!this.active) {
      return;
    }
    this.lastEditor = this.app.workspace.activeEditor || this.lastEditor;
    if (this.lastEditor && this.lastEditor.file) {
      this.contentEl.replaceChildren(
        await renderCard(this.app, this.lastEditor.file, this),
      );
    }
  }

  currentEditorFile(): Maybe<TFile> {
    const editor = this.app.workspace.activeEditor || this.lastEditor;
    return editor?.file;
  }

  async renderToClipboard() {
    let file = this.currentEditorFile();
    if (!file) {
      new Notice("Failed to render card to clipboard");
      return;
    }
    const data = await renderCardToBlob(this.app, file, this);
    if (!data) {
      new Notice("Failed to render card to clipboard");
      return;
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": data,
      }),
    ]);
  }

  async renderToFile() {
    let file = this.currentEditorFile();
    if (file) {
      await renderCardToFile(this.app, file, this);
    } else {
      new Notice("Failed to render card to file");
    }
  }

  async onClose() {
    this.active = false;
  }
}

const renderCard = async (
  app: App,
  file: TFile,
  component: Component,
): Promise<HTMLElement> => {
  const cardEl = createDiv({ cls: "card-forge-card" });
  const headerEl = cardEl.createDiv({ cls: "cf-header" });
  const bodyEl = cardEl.createDiv({ cls: "cf-body" });
  const footerEl = cardEl.createDiv({ cls: "cf-footer" });
  const typeEl = footerEl.createDiv({ cls: "cf-type" });
  const numberEl = footerEl.createDiv({ cls: "cf-number" });

  const metadata = (app.metadataCache.getFileCache(file)?.frontmatter ||
    {}) as Record<string, unknown>;
  headerEl.appendText((metadata[FRONTMATTER_TITLE] as string) || file.basename);
  typeEl.appendText((metadata[FRONTMATTER_TYPE] as string) || "");
  if (metadata["cssclasses"]) {
    cardEl.classList.add(metadata["cssclasses"] as string);
  }
  const rawNumber = metadata[FRONTMATTER_NUMBER];
  if (rawNumber !== undefined && typeof rawNumber === "number") {
    // pad number with zeroes
    numberEl.appendText(
      rawNumber <= 999 ? `00${rawNumber}`.slice(-3) : `${rawNumber}`,
    );
  }

  await MarkdownRenderer.render(
    app,
    await app.vault.cachedRead(file),
    bodyEl,
    file.path,
    component,
  );

  return cardEl;
};

function resolveAttachmentFolder(app: App, file: TFile): string {
  const setting = app.vault.getConfig<string>("attachmentFolderPath");
  if (!setting) {
    // Same folder as current file
    return file.parent?.path ?? "";
  }
  if (setting.startsWith("./")) {
    // Subfolder under current folder
    return file.parent
      ? `${file.parent.path}/${setting.slice(2)}`
      : setting.slice(2);
  }
  // Fixed folder
  return setting;
}

const renderCardToBlob = async (
  app: App,
  file: TFile,
  component: Component,
): Promise<Maybe<Blob>> => {
  const cardEl = await renderCard(app, file, component);

  const mount = createDiv();
  mount.className = "card-forge-render-surface";
  document.body.appendChild(mount);

  try {
    mount.appendChild(cardEl);

    // wait for layout
    await new Promise(requestAnimationFrame);

    return await toBlob(cardEl, {
      pixelRatio: 4,
      width: 238,
      height: 332,
    });
  } finally {
    mount.remove();
  }
};

const renderCardToFile = async (
  app: App,
  file: TFile,
  component: Component,
) => {
  let data = await (
    await renderCardToBlob(app, file, component)
  )?.arrayBuffer();
  if (!data) {
    new Notice("Failed to render card to file");
    return;
  }

  const meta = app.metadataCache.getFileCache(file);
  const frontmatter = (meta?.frontmatter || {}) as Record<string, unknown>;
  const cf_type: string = (frontmatter[FRONTMATTER_TYPE] as string) || "unknown";

  const rawNum = frontmatter[FRONTMATTER_NUMBER];
  const cf_num: number = typeof rawNum === "number" ? rawNum : 0;
  let cf_num_pad = cf_num <= 999 ? `00${cf_num}`.slice(-3) : `${cf_num}`;

  const attachments = resolveAttachmentFolder(app, file);
  const name = file.basename.toLowerCase().replace(/ /g, "-");
  const path = `${attachments}/cf-${cf_type}-${cf_num_pad}-${name}.png`.replace(
    /^\/+/,
    "",
  );

  let card = app.vault.getFileByPath(path);
  if (card) {
    await app.vault.modifyBinary(card, data);
  } else {
    card = await app.vault.createBinary(path, data);
  }

  // now update the `card-image` property on the current editor file
  await app.fileManager.processFrontMatter(
    file,
    (meta: Record<string, unknown>) => {
      meta[FRONTMATTER_IMAGE] = app.fileManager
        .generateMarkdownLink(card, file.path)
        .replace(/^!/, "");
    },
  );
};

class CardForgeSettingsTab extends PluginSettingTab {
  plugin: CardForgePlugin;

  constructor(app: App, plugin: CardForgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Card tag")
      .setDesc("Use this tag when bulk generating card images")
      .addText((text) =>
        text.setValue(this.plugin.settings.cardTag).onChange(async (value) => {
          this.plugin.settings.cardTag = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
