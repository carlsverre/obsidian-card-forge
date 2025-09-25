import {
  App,
  Component,
  ItemView,
  MarkdownFileInfo,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TagCache,
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
      id: "card-forge-open-preview",
      name: "Open Preview",
      callback: async () => {
        await this.activatePreview();
      },
    });

    this.addCommand({
      id: "card-forge-render-cards",
      name: "Render tagged cards",
      callback: async () => {
        await this.renderTaggedCards();
      },
    });

    this.addCommand({
      id: "card-forge-render-cards",
      name: "Number cards",
      callback: async () => {
        await this.numberCards();
      },
    });

    this.addSettingTab(new CardForgeSettingsTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
      new Notice("failed to activate CardForgePreview");
      return;
    }

    workspace.revealLeaf(leaf);
  }

  async getAllCards(): Promise<TFile[]> {
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
        console.log("CardForge: ignoring template", file.path);
        return false;
      }
      let meta = this.app.metadataCache.getFileCache(file);
      return meta?.frontmatter?.tags?.some((t: string) => t === tag);
    });
  }

  async renderTaggedCards() {
    const files = await this.getAllCards();
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
    const files = await this.getAllCards();
    let nextNum = 1;

    // update nextNum to be the largest existing card number
    for (let file of files) {
      const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (meta && meta[FRONTMATTER_NUMBER] !== undefined) {
        nextNum = Math.max(nextNum, meta[FRONTMATTER_NUMBER] + 1);
      }
    }

    console.log("numbering cards without a number starting with", nextNum);

    for (let file of files) {
      this.app.fileManager.processFrontMatter(file, (meta: any) => {
        if (meta[FRONTMATTER_NUMBER] === undefined) {
          meta[FRONTMATTER_NUMBER] = nextNum++;
        }
      });
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
    return "Card Forge Preview";
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
          .onClick(this.renderToClipboard.bind(this)),
      );
      menu.addItem((item) =>
        item
          .setTitle("Render to file")
          .setIcon("save")
          .onClick(this.renderToFile.bind(this)),
      );
      menu.showAtMouseEvent(event);
    });

    this.registerEvent(
      this.app.workspace.on("file-open", this.render.bind(this)),
    );
    this.registerEvent(this.app.vault.on("modify", this.render.bind(this)));
    this.registerEvent(
      this.app.metadataCache.on("changed", this.render.bind(this)),
    );
    this.render();
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

  const metadata = app.metadataCache.getFileCache(file)?.frontmatter || {};
  headerEl.appendText(metadata[FRONTMATTER_TITLE] || file.basename);
  typeEl.appendText(metadata[FRONTMATTER_TYPE] || "");
  if (metadata["cssclasses"]) {
    cardEl.classList.add(metadata["cssclasses"]);
  }
  if (metadata[FRONTMATTER_NUMBER]) {
    let number = parseInt(metadata[FRONTMATTER_NUMBER], 10);
    // pad number with zeroes
    numberEl.appendText(number <= 999 ? `00${number}`.slice(-3) : `${number}`);
  }

  MarkdownRenderer.render(
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
  Object.assign(mount.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
    contain: "layout style paint",
  });
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

  let meta = app.metadataCache.getFileCache(file);
  let cf_type: string =
    (meta?.frontmatter || {})[FRONTMATTER_TYPE] || "unknown";

  const attachments = resolveAttachmentFolder(app, file);
  const name = file.basename.toLowerCase().replace(/ /g, "-");
  const path = `${attachments}/cf-${cf_type}-${name}.png`.replace(/^\/+/, "");

  let card = app.vault.getFileByPath(path);
  if (card) {
    await app.vault.modifyBinary(card, data);
  } else {
    card = await app.vault.createBinary(path, data);
  }

  // now update the `card-image` property on the current editor file
  app.fileManager.processFrontMatter(file, (meta) => {
    meta[FRONTMATTER_IMAGE] = app.fileManager
      .generateMarkdownLink(card, file.path)
      .replace(/^!/, "");
  });
};

class CardForgeSettingsTab extends PluginSettingTab {
  plugin: CardForgePlugin;

  constructor(app: App, plugin: CardForgePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.createEl("h2", { text: "Card Forge Settings" });

    new Setting(containerEl)
      .setName("Card Tag")
      .setDesc("Use this tag when bulk generating card images")
      .addText((text) =>
        text.setValue(this.plugin.settings.cardTag).onChange(async (value) => {
          this.plugin.settings.cardTag = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
