import { ExcalidrawElement } from "obsidian-excalidraw-plugin";
import { ToggleButton } from "src/Components/ToggleButton";
import { t } from "src/lang/helpers";
import ExcaliBrain from "src/excalibrain-main";
import { splitFolderAndFilename } from "src/utils/fileUtils";
import { PageSuggest } from "../Suggesters/PageSuggester";
import { LinkTagFilter } from "./LinkTagFilter";
import { EditableFileView, getIcon, TextFileView, WorkspaceLeaf } from "obsidian";
import { addVerticalDivider } from "./VerticalDivider";
import { RangeSlider } from "./RangeSlider";

export class ToolsPanel {
  private wrapperDiv: HTMLDivElement;
  private buttons: (ToggleButton|RangeSlider|HTMLElement)[] = [];
  public linkTagFilter: LinkTagFilter;
  public searchElement: HTMLInputElement;

  constructor(
    private contentEl: HTMLElement,
    private plugin: ExcaliBrain
  ) {
    contentEl.addClass("excalibrain-contentEl");
    this.wrapperDiv = this.contentEl.createDiv({
      cls: "excalibrain-toolspanel-wrapper"
    });
    
    const dropdownWrapperDiv = this.wrapperDiv.createDiv({
      cls: "excalibrain-dropdown-wrapper"
    });
    
    //------
    //search
    //------
    const inputEl = dropdownWrapperDiv.createEl("input",{
      type: "text",
      cls: "excalibrain-searchinput"
    });
    inputEl.ariaLabel = t("SEARCH_IN_VAULT");
    inputEl.oninput = () => {
      const page = this.plugin.pages.get(inputEl.value);
      if(page) {
        this.plugin.scene?.renderGraphForPath(page.path);
      }
    }
    inputEl.onblur = () => {
      inputEl.value = "";
    }
    new PageSuggest(
      this.plugin.app,
      inputEl,
      this.plugin,
      contentEl
    );
    this.searchElement = inputEl;

    //-------
    //Filter
    //-------
    this.linkTagFilter = new LinkTagFilter(plugin,dropdownWrapperDiv);
    this.linkTagFilter.render();
    
    
    const buttonsWrapperDiv = this.wrapperDiv.createDiv({
      cls: "excalibrain-buttons"
    })

    //------------
    //Edit drawing
    //------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => false,
        setVal: (val: boolean) => {
          const elements = this.plugin.EA.getExcalidrawAPI().getSceneElements() as ExcalidrawElement[];
          const appState = this.plugin.EA.getExcalidrawAPI().getAppState();
          const ea = this.plugin.EA; //window.ExcalidrawAutomate;
          ea.reset();
          ea.canvas.viewBackgroundColor = appState.viewBackgroundColor;
          ea.canvas.theme = "light";
          elements.forEach((el) => (ea.elementsDict[el.id] = el));
          ea.create({
            filename: `ExcaliBrain Snapshot - ${splitFolderAndFilename(
              this.plugin.scene.centralPagePath
            ).basename}`,
            onNewPane: true,
          });
          return false;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "✏",
          icon: getIcon("lucide-pencil").outerHTML,
          tooltip: t("OPEN_DRAWING"),
        },
        updateIndex: true,
      })
    );

    addVerticalDivider(buttonsWrapperDiv);

    //------------
    //Navigate back
    //------------
    const bb = new ToggleButton({
      plugin: this.plugin,
      getVal: () => false,
      setVal: (val: boolean) => {
        this.plugin.scene.renderGraphForPath(this.plugin.navigationHistory.getPrevious());
        this.rerender();
        return false;
      },
      isEnabled: () => this.plugin.navigationHistory.hasPrevious(),
      wrapper: buttonsWrapperDiv,
      options: {
        display: "<",
        icon: getIcon("lucide-arrow-big-left").outerHTML,
        tooltip: t("NAVIGATE_BACK"),
      },
      updateIndex: false,
      shouldRerenderOnToggle: false,
    });
    this.buttons.push(bb);

    //------------
    //Navigate forward
    //------------
    const fb = new ToggleButton({
      plugin: this.plugin,
      getVal: () => false,
      setVal: (val: boolean) => {
        this.plugin.scene.renderGraphForPath(this.plugin.navigationHistory.getNext());
        this.rerender();
        return false;
      },
      isEnabled: () => this.plugin.navigationHistory.hasNext(),
      wrapper: buttonsWrapperDiv,
      options: {
        display: ">",
        icon: getIcon("lucide-arrow-big-right").outerHTML,
        tooltip: t("NAVIGATE_FORWARD"),
      },
      updateIndex: false,
      shouldRerenderOnToggle: false,
    });

    this.buttons.push(fb);
    this.plugin.navigationHistory.setNavigateButtons([bb,fb]);

    //------------
    //Refresh view
    //------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => false,
        setVal: (val: boolean) => false,
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🔄",
          icon: getIcon("lucide-refresh-cw").outerHTML,
          tooltip: t("REFRESH_VIEW"),
        },
        updateIndex: true,
      })
    );

    //------------
    //Pin Leaf
    //------------
    const pinLeafButton = new ToggleButton({
      plugin: this.plugin,
      getVal: () => this.plugin.scene.pinLeaf,
      setVal: (val: boolean) => {
        this.plugin.scene.pinLeaf = val;
        if(val) {
          const leaves: WorkspaceLeaf[] = [];
          this.plugin.app.workspace.iterateAllLeaves(leaf => {
            if(
              leaf.view?.getViewType() === "empty" ||
              leaf.view instanceof EditableFileView && leaf !== this.plugin.scene?.leaf
            ) {
              leaves.push(leaf);
            }
          });
          leaves.sort((a,b) => (a.activeTime - b.activeTime)>0?-1:1);
          if(leaves.length>0) {
            this.plugin.scene.centralLeaf = leaves[0];
          }
        }
        return true;
      },
      isEnabled: () => {
        if(!this.plugin.settings.autoOpenCentralDocument) return false;
        if(this.plugin.scene && !this.plugin.scene.isCentralLeafStillThere()) {
          this.plugin.scene.pinLeaf = false;
        }
        return true;
      },
      wrapper: buttonsWrapperDiv,
      options: {
        display: "📌",
        icon: {
          on: getIcon("lucide-pin").outerHTML,
          off: getIcon("lucide-pin-off").outerHTML,
        },
        tooltip: t("PIN_LEAF"),
      },
      updateIndex: false,
    })
    this.buttons.push(pinLeafButton);

    //------------
    //Automatically open central node in leaf
    //------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.autoOpenCentralDocument,
        setVal: (val: boolean) => {
          this.plugin.settings.autoOpenCentralDocument = val;
          pinLeafButton.updateButton();
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🔌",
          icon: {
            on: `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256"><path d="M237.66,18.34a8,8,0,0,0-11.32,0l-52.4,52.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L100,88.69l-6.34-6.35A8,8,0,0,0,82.34,93.66L88.69,100,65.37,123.31a32,32,0,0,0,0,45.26l5.38,5.37-52.41,52.4a8,8,0,0,0,11.32,11.32l52.4-52.41,5.37,5.38a32,32,0,0,0,45.26,0L156,167.31l6.34,6.35a8,8,0,0,0,11.32-11.32L167.31,156l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,52.41-52.4A8,8,0,0,0,237.66,18.34Zm-116.29,161a16,16,0,0,1-22.62,0L76.69,157.25a16,16,0,0,1,0-22.62L100,111.31,144.69,156Zm57.94-57.94L156,144.69,111.31,100l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,179.31,121.37ZM88.41,34.53a8,8,0,0,1,15.18-5.06l8,24a8,8,0,0,1-15.18,5.06Zm-64,58.94a8,8,0,0,1,10.12-5.06l24,8a8,8,0,0,1-5.06,15.18l-24-8A8,8,0,0,1,24.41,93.47Zm207.18,69.06a8,8,0,0,1-10.12,5.06l-24-8a8,8,0,0,1,5.06-15.18l24,8A8,8,0,0,1,231.59,162.53Zm-64,58.94a8,8,0,0,1-15.18,5.06l-8-24a8,8,0,0,1,15.18-5.06Z"></path></svg>`,
            off:`<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 256 256"><path d="M149.66,138.34a8,8,0,0,0-11.32,0L120,156.69,99.31,136l18.35-18.34a8,8,0,0,0-11.32-11.32L88,124.69,69.66,106.34a8,8,0,0,0-11.32,11.32L64.69,124,41.37,147.31a32,32,0,0,0,0,45.26l5.38,5.37-28.41,28.4a8,8,0,0,0,11.32,11.32l28.4-28.41,5.37,5.38a32,32,0,0,0,45.26,0L132,191.31l6.34,6.35a8,8,0,0,0,11.32-11.32L131.31,168l18.35-18.34A8,8,0,0,0,149.66,138.34Zm-52.29,65a16,16,0,0,1-22.62,0L52.69,181.25a16,16,0,0,1,0-22.62L76,135.31,120.69,180Zm140.29-185a8,8,0,0,0-11.32,0l-28.4,28.41-5.37-5.38a32.05,32.05,0,0,0-45.26,0L124,64.69l-6.34-6.35a8,8,0,0,0-11.32,11.32l80,80a8,8,0,0,0,11.32-11.32L191.31,132l23.32-23.31a32,32,0,0,0,0-45.26l-5.38-5.37,28.41-28.4A8,8,0,0,0,237.66,18.34Zm-34.35,79L180,120.69,135.31,76l23.32-23.31a16,16,0,0,1,22.62,0l22.06,22A16,16,0,0,1,203.31,97.37Z"></path></svg>`,
          },
          tooltip: t("AUTO_OPEN_DOCUMENT"),
        },
        updateIndex: false,
      })
    );

    addVerticalDivider(buttonsWrapperDiv);

    // ------------
    // Attachments
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showAttachments,
        setVal: (val: boolean) => {
          this.plugin.settings.showAttachments = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "📎",
          icon: getIcon("lucide-paperclip").outerHTML,
          tooltip: t("SHOW_HIDE_ATTACHMENTS"),
        },
        updateIndex: true,
      }),
    );

    // ------------
    // Virtual
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showVirtualNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showVirtualNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "∅",
          icon: getIcon("lucide-minus-circle").outerHTML,
          tooltip: t("SHOW_HIDE_VIRTUAL"),
        },
        updateIndex: false,
      })
    );

    // ------------
    // Inferred
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showInferredNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showInferredNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🤔",
          icon: getIcon("lucide-git-pull-request-draft").outerHTML,
          tooltip: t("SHOW_HIDE_INFERRED"),
        },
        updateIndex: true,
      })
    );

    // ------------
    // Page
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showPageNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showPageNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "📄",
          icon: getIcon("lucide-file-text").outerHTML,
          tooltip: t("SHOW_HIDE_PAGES"),
        },
        updateIndex: true,
      })
    );

    // ------------
    // Alias
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.renderAlias,
        setVal: (val: boolean) => {
          this.plugin.settings.renderAlias = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🧥",
          icon: getIcon("lucide-venetian-mask").outerHTML,
          tooltip: t("SHOW_HIDE_ALIAS"),
        },
        updateIndex: false,
      })
    );

    // ------------
    // Folder
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showFolderNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showFolderNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "📂",
          icon: getIcon("lucide-folder").outerHTML,
          tooltip: t("SHOW_HIDE_FOLDER"),
        },
        updateIndex: true,
      })
    );

    // ------------
    // Tag
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showTagNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showTagNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "#",
          icon: getIcon("lucide-tag").outerHTML,
          tooltip: t("SHOW_HIDE_TAG"),
        },
        updateIndex: false,
      })
    );

    // ------------
    // Render weblinks in page
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.showURLNodes,
        setVal: (val: boolean) => {
          this.plugin.settings.showURLNodes = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🌐",
          icon: getIcon("lucide-globe").outerHTML,
          tooltip: t("SHOW_HIDE_URLS"),
        },
        updateIndex: false,
      })
    );

    // ------------
    // Display siblings
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.renderSiblings,
        setVal: (val: boolean) => {
          this.plugin.settings.renderSiblings = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "👨‍👩‍👧‍👦",
          icon: getIcon("lucide-grip").outerHTML,
          tooltip: t("SHOW_HIDE_SIBLINGS"),
        },
        updateIndex: false,
      })
    );

    // ------------
    // Power Filter
    // ------------
    /*this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.applyPowerFilter,
        setVal: (val: boolean) => {
          this.plugin.settings.applyPowerFilter = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "V",
          icon: getIcon("lucide-filter").outerHTML,
          tooltip: t("SHOW_HIDE_POWERFILTER"),
        },
        updateIndex: false,
      })
    );*/

    // ------------
    // Central node as interactive frame
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.embedCentralNode,
        setVal: (val: boolean) => {
          this.plugin.settings.embedCentralNode = val;
          if(this.plugin.settings.toggleEmbedTogglesAutoOpen) {
            this.plugin.settings.autoOpenCentralDocument = !val;
          }
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "⏹️",
          icon: getIcon("lucide-code").outerHTML,
          tooltip: t("SHOW_HIDE_EMBEDDEDCENTRAL"),
        },
        updateIndex: false,
      })
    );

    addVerticalDivider(buttonsWrapperDiv);

    // ------------
    // Display Compact Button
    // ------------
    this.buttons.push(
      new ToggleButton({
        plugin: this.plugin,
        getVal: () => this.plugin.settings.compactView,
        setVal: (val: boolean) => {
          this.plugin.settings.compactView = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        options: {
          display: "🗃️",
          icon: getIcon("lucide-minimize-2").outerHTML,
          tooltip: t("COMPACT_VIEW_NAME"),
        },
        updateIndex: false,
      })
    );    
    // ------------
    // Display Compact factor
    // ------------
    this.buttons.push(
      new RangeSlider({
        plugin: this.plugin,
        setVal: (val) => {
          this.plugin.settings.compactingFactor = val;
          return true;
        },
        wrapper: buttonsWrapperDiv,
        range: {
          min: 1,
          max: 2,
          step: 0.1,
          defalutValue: this.plugin.settings.compactingFactor
        },
        updateIndex: false,
      })
    )

    this.contentEl.appendChild(this.wrapperDiv);
  }

  rerender() {
    this.buttons.forEach(b => {
      if(b instanceof ToggleButton) b.updateButton();
    });
    this.linkTagFilter.render();
  }

  terminate() {
    if(this.contentEl) {
      this.contentEl.removeClass("excalibrain-contentEl");
    }   
    if(this.wrapperDiv) {
      try{
        this.contentEl?.removeChild(this.wrapperDiv);
      } catch{}
      this.wrapperDiv = null;
    }
  }
}