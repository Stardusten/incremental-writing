import {
  EventRef,
  TFolder,
  Plugin,
  TFile,
  ButtonComponent,
  getAllTags,
  debounce,
  TAbstractFile,
  normalizePath,
  MarkdownView, Editor,
} from "obsidian";
import { Queue } from "./queue";
import { LogTo } from "./logger";
import {
  ReviewFileModal,
  ReviewNoteModal,
  ReviewBlockModal,
} from "./views/modals";
import { IWSettings, DefaultSettings } from "./settings";
import { IWSettingsTab } from "./views/settings-tab";
import { StatusBar } from "./views/status-bar";
import { QueueLoadModal } from "./views/queue-modal";
import { LinkEx } from "./helpers/link-utils";
import { FileUtils } from "./helpers/file-utils";
import { BulkAdderModal } from "./views/bulk-adding";
import { BlockUtils } from "./helpers/block-utils";
import { FuzzyNoteAdder } from "./views/fuzzy-note-adder";
import { MarkdownTableRow } from "./markdown";
import { NextRepScheduler } from "./views/next-rep-schedule";
import { EditDataModal } from "./views/edit-data";
import { DateParser } from "./helpers/parse-date";
import { CreateQueueModal } from "./views/create-queue";

export default class IW extends Plugin {
  public settings: IWSettings;
  public statusBar: StatusBar;
  public queue: Queue;

  //
  // Utils

  public readonly links: LinkEx = new LinkEx(this.app);
  public readonly files: FileUtils = new FileUtils(this.app);
  public readonly blocks: BlockUtils = new BlockUtils(this.app);
  public readonly dates: DateParser = new DateParser(this.app);

  private autoAddNewNotesOnCreateEvent: EventRef;

  async loadConfig() {
    this.settings = this.settings = Object.assign(
      {},
      DefaultSettings,
      await this.loadData()
    );
  }

  getQueueFiles() {
    const abstractFiles = this.app.vault.getAllLoadedFiles();
    const queueFiles = abstractFiles.filter((file: TAbstractFile) => {
      return (
        file instanceof TFile &&
        file.parent.path === this.settings.queueFolderPath &&
        file.extension === "md"
      );
    });
    return <TFile[]>queueFiles;
  }

  getDefaultQueuePath() {
    return normalizePath(
      [this.settings.queueFolderPath, this.settings.queueFileName].join("/")
    );
  }

  async onload() {
    LogTo.Console("Loading...");
    await this.loadConfig();
    const naturalLanguageDates = (this.app as any).plugins.getPlugin(
        "nldates-obsidian"
    );
    if (!naturalLanguageDates)
      return;
    this.addSettingTab(new IWSettingsTab(this.app, this));
    this.registerCommands();
    this.subscribeToEvents();
  }

  randomWithinInterval(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  autoAddNewNotesOnCreate() {
    if (this.settings.autoAddNewNotes) {
      this.autoAddNewNotesOnCreateEvent = this.app.vault.on(
        "create",
        async (file) => {
          if (!(file instanceof TFile) || file.extension !== "md") {
            return;
          }
          let link = this.files.toLinkText(file);
          let min = this.settings.defaultPriorityMin;
          let max = this.settings.defaultPriorityMax;
          let priority = this.randomWithinInterval(min, max);
          let row = new MarkdownTableRow(link, priority, "");
          LogTo.Console("Auto adding new note to default queue: " + link);
          await this.queue.add(row);
        }
      );
    } else {
      if (this.autoAddNewNotesOnCreateEvent) {
        this.app.vault.offref(this.autoAddNewNotesOnCreateEvent);
        this.autoAddNewNotesOnCreateEvent = undefined;
      }
    }
  }

  async getSearchLeafView() {
    return this.app.workspace.getLeavesOfType("search")[0]?.view;
  }

  async getFound() {
    const view = await this.getSearchLeafView();
    if (!view) {
      LogTo.Console("Failed to get search leaf view.");
      return [];
    }
    // @ts-ignore
    return Array.from(view.dom.resultDomLookup.keys());
  }

  async addSearchButton() {
    const view = await this.getSearchLeafView();
    if (!view) {
      LogTo.Console("Failed to add button to the search pane.");
      return;
    }
    (<any>view).addToQueueButton = new ButtonComponent(
      view.containerEl.children[0].firstChild as HTMLElement
    )
      .setClass("nav-action-button")
      .setIcon("sheets-in-box")
      .setTooltip("Add to IW Queue")
      .onClick(async () => await this.addSearchResultsToQueue());
  }

  async getSearchResults(): Promise<TFile[]> {
    return (await this.getFound()) as TFile[];
  }

  async addSearchResultsToQueue() {
    const files = await this.getSearchResults();
    const pairs = files.map((file) =>
      this.links.createAbsoluteLink(normalizePath(file.path), "")
    );
    if (pairs && pairs.length > 0) {
      new BulkAdderModal(
        this,
        this.queue.queuePath,
        "Bulk Add Search Results",
        pairs
      ).open();
    } else {
      LogTo.Console("No files to add.", true);
    }
  }

  async updateStatusBar() {
    const table = await this.queue.loadTable();
    this.statusBar.updateCurrentRep(table?.currentRep());
    this.statusBar.updateCurrentQueue(this.queue.queuePath);
  }

  async loadQueue(file: string) {
    if (file && file.length > 0) {
      this.queue = new Queue(this, file);
      await this.updateStatusBar();
      LogTo.Console("Loaded Queue: " + file, true);
    } else {
      LogTo.Console("Failed to load queue.", true);
    }
  }

  registerCommands() {
    //
    // Queue Creation

    this.addCommand({
      id: "create-new-iw-queue",
      name: "Create and load a new queue.",
      callback: () => new CreateQueueModal(this).open(),
      hotkeys: [],
    });

    //
    // Queue Browsing

    this.addCommand({
      id: "open-queue-current-pane",
      name: "Open queue in current pane.",
      callback: () => this.queue.goToQueue(false),
      hotkeys: [],
    });

    this.addCommand({
      id: "open-queue-new-pane",
      name: "Open queue in new pane.",
      callback: () => this.queue.goToQueue(true),
      hotkeys: [],
    });

    //
    // Repetitions

    this.addCommand({
      id: "current-iw-repetition",
      name: "Current repetition.",
      callback: async () => await this.queue.goToCurrentRep(),
      hotkeys: [],
    });

    this.addCommand({
      id: "dismiss-current-repetition",
      name: "Dismiss current repetition.",
      callback: async () => {
        await this.queue.dismissCurrent();
      },
      hotkeys: [],
    });

    this.addCommand({
      id: "next-iw-repetition-schedule",
      name: "Next repetition and manually schedule.",
      callback: async () => {
        const table = await this.queue.loadTable();
        if (!table || !table.hasReps()) {
          LogTo.Console("No repetitions!", true);
          return;
        }
        const currentRep = table.currentRep();
        if (await this.queue.nextRepetition()) {
          new NextRepScheduler(this, currentRep, table).open();
        }
      },
    });

    this.addCommand({
      id: "next-iw-repetition",
      name: "Next repetition.",
      callback: async () => await this.queue.nextRepetition(),
      hotkeys: [],
    });

    this.addCommand({
      id: "edit-current-rep-data",
      name: "Edit current rep data. ",
      callback: async () => {
        const table = await this.queue.loadTable();
        if (!table || !table.hasReps()) {
          LogTo.Debug("No repetitions!", true);
          return;
        }

        const curRep = table.currentRep();
        if (!curRep) {
          LogTo.Debug("No current repetition!", true);
          return;
        }

        new EditDataModal(this, curRep, table).open();
        await this.updateStatusBar();
      },
      hotkeys: [],
    });

    //
    // Element Adding.

    this.addCommand({
      id: "add-links-in-selected-text",
      name: "Add links in selected text.",
      editorCheckCallback: (checking, editor: Editor, view: MarkdownView) => {
        const file = this.app.workspace.getActiveFile();

        if (file && editor) {
          if (!checking) {
            const links = this.app.metadataCache.getFileCache(file).links ?? [];
            if (!links || links.length === 0) {
              LogTo.Debug("Active note does not contain any links.", true);
              return;
            }

            const selection = editor.getSelection();
            if (!selection || selection.length === 0) {
              LogTo.Debug("No selected text.", true);
              return;
            }

            const selectedLinks = Array.from(
              links
                .filter((link) => selection.contains(link.original))
                .map((link) =>
                  this.links.createAbsoluteLink(link.link, file.path)
                )
                .filter((link) => link !== null && link.length > 0)
                .reduce((set, link) => set.add(link), new Set<string>())
            );

            if (!selectedLinks || selectedLinks.length === 0) {
              LogTo.Debug("No selected links.", true);
              return;
            }

            LogTo.Debug("Selected links: " + selectedLinks.toString());
            new BulkAdderModal(
              this,
              this.queue.queuePath,
              "Bulk Add Links",
              selectedLinks
            ).open();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "bulk-add-blocks",
      name: "Bulk add blocks with references to queue.",
      checkCallback: (checking) => {
        const file = this.files.getActiveNoteFile();
        if (file != null) {
          if (!checking) {
            const refs = this.app.metadataCache.getFileCache(file).blocks;
            if (!refs) {
              LogTo.Debug("File does not contain any blocks with references.");
            } else {
              const fileLink = this.app.metadataCache.fileToLinktext(
                file,
                "",
                true
              );
              const linkPaths = Object.keys(refs).map(
                (l) => fileLink + "#^" + l
              );
              new BulkAdderModal(
                this,
                this.queue.queuePath,
                "Bulk Add Block References",
                linkPaths
              ).open();
            }
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "note-add-iw-queue",
      name: "Add note to queue.",
      checkCallback: (checking: boolean) => {
        if (this.files.getActiveNoteFile() !== null) {
          if (!checking) {
            new ReviewNoteModal(this).open();
          }
          return true;
        }
        return false;
      },
    });

    this.addCommand({
      id: "fuzzy-note-add-iw-queue",
      name: "Add note to queue through a fuzzy finder",
      callback: () => new FuzzyNoteAdder(this).open(),
      hotkeys: [],
    });

    this.addCommand({
      id: "block-add-iw-queue",
      name: "Add block to queue.",
      checkCallback: (checking: boolean) => {
        if (this.files.getActiveNoteFile() != null) {
          if (!checking) {
            new ReviewBlockModal(this).open();
          }
          return true;
        }
        return false;
      },
      hotkeys: [],
    });

    this.addCommand({
      id: "add-links-within-note",
      name: "Add links within note to queue.",
      checkCallback: (checking: boolean) => {
        const file = this.files.getActiveNoteFile();
        if (file !== null) {
          if (!checking) {
            const links = this.links.getLinksIn(file);
            if (links && links.length > 0) {
              new BulkAdderModal(
                this,
                this.queue.queuePath,
                "Bulk Add Links",
                links
              ).open();
            } else {
              LogTo.Console("No links in the current file.", true);
            }
          }
          return true;
        }
        return false;
      },
      hotkeys: [],
    });

    //
    // Queue Loading

    this.addCommand({
      id: "load-iw-queue",
      name: "Load a queue.",
      callback: () => {
        new QueueLoadModal(this).open();
      },
      hotkeys: [],
    });
  }

  createStatusBar() {
    this.statusBar = new StatusBar(this.addStatusBarItem(), this);
    this.statusBar.initStatusBar();
  }

  subscribeToEvents() {
    this.app.workspace.onLayoutReady(async () => {
      this.createStatusBar();
      const queuePath = this.getDefaultQueuePath();
      await this.loadQueue(queuePath);
      this.addSearchButton();
      this.autoAddNewNotesOnCreate();
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _: string) => {
        if (file == null) {
          return;
        }

        if (file instanceof TFile && file.extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle(`Add File to IW Queue`)
              .setIcon("sheets-in-box")
              .onClick((_) => {
                new ReviewFileModal(this, file.path).open();
              });
          });
        } else if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(`Add Folder to IW Queue`)
              .setIcon("sheets-in-box")
              .onClick((_) => {
                const pairs = this.app.vault
                  .getMarkdownFiles()
                  .filter((f) => this.files.isDescendantOf(f, file))
                  .map((f) =>
                    this.links.createAbsoluteLink(normalizePath(f.path), "")
                  );

                if (pairs && pairs.length > 0) {
                  new BulkAdderModal(
                    this,
                    this.queue.queuePath,
                    "Bulk Add Folder Notes",
                    pairs
                  ).open();
                } else {
                  LogTo.Console("Folder contains no files!", true);
                }
              });
          });
        }
      })
    );
  }

  async removeSearchButton() {
    let searchView = await this.getSearchLeafView();
    let btn = (<any>searchView)?.addToQueueButton;
    if (btn) {
      btn.buttonEl?.remove();
      btn = null;
    }
  }

  unsubscribeFromEvents() {
    for (let e of [
      this.autoAddNewNotesOnCreateEvent,
    ]) {
      this.app.vault.offref(e);
      e = undefined;
    }
  }

  async onunload() {
    LogTo.Console("Disabled and unloaded.");
    await this.removeSearchButton();
    this.unsubscribeFromEvents();
  }
}
