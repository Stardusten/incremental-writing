import {
  normalizePath,
  TFolder,
  MarkdownView,
  SliderComponent,
  TextComponent,
  ButtonComponent, Setting,
} from "obsidian";
import IW from "../main";
import { ModalBase } from "./modal-base";
import { LogTo } from "../logger";
import { FileSuggest } from "./file-suggest";
import { Queue } from "../queue";
import { PriorityUtils } from "../helpers/priority-utils";
import { MarkdownTableRow } from "../markdown";
import "../helpers/date-utils";
import "../helpers/number-utils";
import { NaturalDateSuggest } from "./date-suggest";
import path from "path";
import {DateParser} from "../helpers/parse-date";

abstract class ReviewModal extends ModalBase {
  private _title: string;
  private _queueFolderTC: TextComponent;
  private _firstRepTC: TextComponent;
  private _noteTC: TextComponent;
  private _priorityTC: TextComponent;
  private readonly dataParser: DateParser;

  constructor(plugin: IW, title: string) {
    super(plugin);
    this._title = title;
    this.dataParser = plugin.dates;
  }

  get title(): string { return this._title; }
  get queueFolderPath(): string {
    const queue = this._queueFolderTC.getValue() == ""
        ? path.relative(
            this.plugin.settings.queueFolderPath,
            this.plugin.queue.queuePath
        )
        : this._queueFolderTC.getValue().withExtension(".md");

    return normalizePath(
        [this.plugin.settings.queueFolderPath, queue].join("/")
    );
  }
  get firstRep(): Date {
    const firstRep = this._firstRepTC.getValue();
    return this.dataParser.parseDate(
        firstRep == ''
            ? this.plugin.settings.defaultFirstRepDate
            : firstRep);
  }
  get note(): string { return this._noteTC.getValue(); }
  get priority(): number {
    return parseInt(this._priorityTC.getValue());
  }
  set priority(priority: number) { this._priorityTC.setValue(priority.toString()); }

  onOpen() {

    this.titleEl.setText(this._title);

    //
    // Queue

    new Setting(this.modalEl)
        .setName('Queue')
        .setDesc('') // TODO
        .addText((text) => {
          this._queueFolderTC = text;
          text.setPlaceholder(
              path.relative(
                  this.plugin.settings.queueFolderPath,
                  this.plugin.queue.queuePath
              )
          );
          const folderFunc = () =>
              this.plugin.app.vault.getAbstractFileByPath(
                  this.plugin.settings.queueFolderPath
              ) as TFolder;
          new FileSuggest(this.plugin, text.inputEl, folderFunc);
        });

    //
    // First Rep Date

    new Setting(this.modalEl)
        .setName('First Rep Date')
        .setDesc('') // TODO
        .addText((text) => {
          this._firstRepTC = text;
          text.setPlaceholder(this.plugin.settings.defaultFirstRepDate);
          new NaturalDateSuggest(this.plugin, text.inputEl);
          text.inputEl.focus();
          text.inputEl.select();
        });

    //
    // Priority

    new Setting(this.modalEl)
        .setName('Priority')
        .setDesc('') // TODO
        .addText((text) => {
          this._priorityTC = text;
          const pMin = this.plugin.settings.defaultPriorityMin;
          const pMax = this.plugin.settings.defaultPriorityMax;
          text.setPlaceholder(`Range: ${pMin} ~ ${pMax}`);
        });

    //
    // Notes

    new Setting(this.modalEl)
        .setName('Notes')
        .setDesc('') // TODO
        .addText((text) => {
          this._noteTC = text;
        });

    //
    // Button

    new ButtonComponent(this.modalEl)
        .setButtonText('Add to Queue')
        .onClick(async () => {
          await this.addToOutstanding();
          this.close();
        });

    this.subscribeToEvents();
  }

  subscribeToEvents() {
    this.contentEl.addEventListener("keydown", async (ev) => {
      if (ev.key === "PageUp") {
        let curValue = this.priority;
        if (curValue < 95) this.priority = curValue + 5;
        else this.priority = 100;
      } else if (ev.key === "PageDown") {
        let curValue = this.priority;
        if (curValue > 5) this.priority = curValue -5;
        else this.priority = 0;
      } else if (ev.key === "Enter") {
        await this.addToOutstanding();
        this.close();
      }
    });
  }

  onClose() {
    super.onClose();
    this.containerEl.empty();
  }

  abstract addToOutstanding(): Promise<void>;
}

export class ReviewNoteModal extends ReviewModal {

  constructor(plugin: IW) {
    super(plugin, "Add Note to Outstanding?");
  }

  async addToOutstanding() {
    if (!this.firstRep)
      return;
    const queue = new Queue(this.plugin, this.queueFolderPath);
    const file = this.plugin.files.getActiveNoteFile();
    if (!file) {
      LogTo.Console("Failed to add to outstanding.", true);
      return;
    }
    const link = this.plugin.files.toLinkText(file);
    const row = new MarkdownTableRow(link, this.priority, this.note, 1, this.firstRep);
    await queue.add(row);
  }
}

export class ReviewFileModal extends ReviewModal {

  filePath: string;

  constructor(plugin: IW, filePath: string) {
    super(plugin, "Add File to Outstanding?");
    this.filePath = filePath;
  }

  onOpen() {
    super.onOpen();
  }

  async addToOutstanding() {
    if (!this.firstRep)
      return;
    const queue = new Queue(this.plugin, this.queueFolderPath);
    const file = this.plugin.files.getTFile(this.filePath);
    if (!file) {
      LogTo.Console("Failed to add to outstanding because file was null", true);
      return;
    }
    const link = this.plugin.files.toLinkText(file);
    const row = new MarkdownTableRow(link, this.priority, this.note, 1, this.firstRep);
    await queue.add(row);
  }
}

export class ReviewBlockModal extends ReviewModal {

  private customBlockRefTC: TextComponent;

  constructor(plugin: IW) {
    super(plugin, "Add Block to Outstanding?");
  }

  onOpen() {
    super.onOpen();
    new Setting(this.modalEl)
        .setName('Block Ref Name')
        .setDesc('') // TODO
        .addText((text) => {
          this.customBlockRefTC = text;
        });
  }

  getCurrentLineNumber(): number | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView) as MarkdownView;
    return view?.editor.getCursor()?.line;
  }

  async addToOutstanding() {
    if (!this.firstRep)
      return;

    const queue = new Queue(this.plugin, this.queueFolderPath);
    const file = this.plugin.files.getActiveNoteFile();
    if (!file) {
      LogTo.Console("Failed to add to outstanding.", true);
      return;
    }

    const lineNumber = this.getCurrentLineNumber();
    if (lineNumber == null) {
      LogTo.Console("Failed to get the current line number.", true);
      return;
    }

    const customRefName = this.customBlockRefTC.getValue();
    const blockLink = await this.plugin.blocks.createBlockRefIfNotExists(
      lineNumber,
      file,
      customRefName
    );
    if (!blockLink || blockLink.length === 0) {
      LogTo.Debug("Failed to add block to queue: block link was invalid.");
      return;
    }

    await queue.add(
      new MarkdownTableRow(blockLink, this.priority, this.note, 1, this.firstRep)
    );
  }
}
