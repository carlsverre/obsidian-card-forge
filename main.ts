import {
  App,
  Component,
  ItemView,
  MarkdownFileInfo,
  MarkdownRenderer,
  Menu,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { toBlob } from "html-to-image";

type Maybe<T> = T | null | undefined;

interface CardForgeSettings {
  renderPath: string;
}

const DEFAULT_SETTINGS: CardForgeSettings = {
  renderPath: "card-forge",
};

export default class CardForgePlugin extends Plugin {
  renderFrame: HTMLIFrameElement;

  async onload() {
    this.renderFrame = createEl("iframe", {
      attr: {
        style:
          "position:fixed;left:-10000px;top:-10000px;width:0;height:0;visibility:hidden;",
      },
    });
    this.app.workspace.containerEl.append(this.renderFrame);

    this.registerView(VIEW_TYPE_PREVIEW, (leaf) => new CardForgePreview(leaf));

    this.addCommand({
      id: "card-forge-open-preview",
      name: "Open Preview",
      callback: async () => {
        await this.activatePreview();
      },
    });
  }

  onunload() {}

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
      throw new Error("failed to activate CardForgePreview");
    }

    workspace.revealLeaf(leaf);
  }
}

export const VIEW_TYPE_PREVIEW = "card-forge-preview";

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

  async renderToBlob(): Promise<Maybe<Blob>> {
    let file = this.currentEditorFile();
    if (file) {
      this.contentEl.empty();
      let cardEl = await renderCard(this.app, file, this);
      this.contentEl.appendChild(cardEl);
      let data = await toBlob(cardEl, {
        pixelRatio: 3,
      });
      return data;
    }
    return null;
  }

  async renderToClipboard() {
    let data = await this.renderToBlob();
    if (!data) {
      throw new Error("Failed to render card to clipboard");
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": data,
      }),
    ]);
  }

  async renderToFile() {
    let data = await (await this.renderToBlob())?.arrayBuffer();
    let file = this.currentEditorFile();
    if (!data || !file) {
      throw new Error("Failed to render card to file");
    }
    const attachments = resolveAttachmentFolder(this.app, file);
    const name = file.basename.toLowerCase().replace(" ", "-");
    const path = `${attachments}/cf-${name}.png`;

    let card = this.app.vault.getFileByPath(path);
    if (card) {
      await this.app.vault.modifyBinary(card, data);
    } else {
      card = await this.app.vault.createBinary(path, data);
    }

    // now update the `card-forge-image` property on the current editor file
    this.app.fileManager.processFrontMatter(file, (meta) => {
      meta["card-forge-image"] = this.app.fileManager
        .generateMarkdownLink(card, file.path)
        .replace(/^!/, "");
    });
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
  const titleEl = headerEl.createDiv({ cls: "cf-title" });
  const typeEl = headerEl.createDiv({ cls: "cf-type" });
  const bodyEl = cardEl.createDiv({ cls: "cf-body" });

  const metadata = app.metadataCache.getFileCache(file)?.frontmatter || {};
  titleEl.appendText(metadata["card-forge-title"] || file.basename);
  typeEl.appendText(metadata["card-forge-type"] || "");
  if (metadata["cssclasses"]) {
    cardEl.classList.add(metadata["cssclasses"]);
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
