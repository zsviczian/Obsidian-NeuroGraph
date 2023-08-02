import { App, FileView, Notice, TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import { ExcalidrawAutomate } from "obsidian-excalidraw-plugin/lib/ExcalidrawAutomate";
import { EMPTYBRAIN } from "./constants/emptyBrainFile";
import { Layout } from "./graph/Layout";
import { Links } from "./graph/Links";
import { Node } from "./graph/Node";
import ExcaliBrain from "./excalibrain-main";
import { ExcaliBrainSettings } from "./Settings";
import { ToolsPanel } from "./Components/ToolsPanel";
import { Mutable, Neighbour, NodeStyle, RelationType, Role } from "./types";
import { HistoryPanel } from "./Components/HistoryPanel";
import { WarningPrompt } from "./utils/Prompts";
import { keepOnTop } from "./utils/utils";
import { ExcalidrawElement } from "obsidian-excalidraw-plugin";
import { isEmbedFileType } from "./utils/fileUtils";
import { Page } from "./graph/Page";
import { ExcalidrawImperativeAPI } from "@zsviczian/excalidraw/types/types"
 
export class Scene {
  ea: ExcalidrawAutomate;
  plugin: ExcaliBrain;
  app: App;
  leaf: WorkspaceLeaf;
  centralPagePath: string; //path of the page in the center of the graph
  centralPageFile: TFile;
  public centralLeaf: WorkspaceLeaf; //workspace leaf containing the central page
  textSize: {width:number, height:number};
  nodeWidth: number;
  nodeHeight: number;
  public disregardLeafChange: boolean = false;
  public terminated: boolean;
  public nodesMap: Map<string,Node> = new Map<string,Node>();
  public links: Links;
  private layouts: Layout[] = [];
  private removeEH: Function;
  private removeTimer: Function;
  private removeOnCreate: Function;
  private removeOnModify: Function;
  private removeOnDelete: Function;
  private removeOnRename: Function;
  private blockUpdateTimer: boolean = false;
  public toolsPanel: ToolsPanel;
  private historyPanel: HistoryPanel;
  public vaultFileChanged: boolean = false;
  public pinLeaf: boolean = false;
  public focusSearchAfterInitiation: boolean = true;
  private zoomToFitOnNextBrainLeafActivate: boolean = false; //this addresses the issue caused in Obsidian 0.16.0 when the brain graph is rendered while the leaf is hidden because tab is not active
  private rootNode: Node;

  constructor(plugin: ExcaliBrain, newLeaf: boolean, leaf?: WorkspaceLeaf) {
    this.ea = plugin.EA;
    this.plugin = plugin;
    this.app = plugin.app;
    this.leaf = leaf ?? app.workspace.getLeaf(newLeaf);
    this.terminated = false;
    this.links = new Links(plugin);
  }

  public getCentralLeaf(): WorkspaceLeaf {
    if(!this.plugin.settings.autoOpenCentralDocument) {
      return null;
    }
    return this.centralLeaf;
  }

  public async initialize(focusSearchAfterInitiation: boolean) {
    this.focusSearchAfterInitiation = focusSearchAfterInitiation;
    await this.plugin.loadSettings();
    if(!this.leaf?.view) return;
    this.toolsPanel = new ToolsPanel((this.leaf.view as TextFileView).contentEl.querySelector(".excalidraw"),this.plugin);
    this.initializeScene();
  }

  /**
   * Check if ExcaliBrain is currently active
   * @returns boolean; true if active
   */
  public isActive() {
    //@ts-ignore
    return !this.terminated && app.workspace.getLeafById(this.leaf?.id)
  }

  /**
   * Updates the current Scene applying changes in the Index
   * @returns 
   */
  public async reRender(updateIndex:boolean = true) {
    if(!this.isActive()) {
      return;
    }

    if(!this.centralPagePath) {
      return;
    }

    if(updateIndex) {
      this.vaultFileChanged = false;
      await this.plugin.createIndex(); //temporary
    }

    keepOnTop(this.ea);
    const centralPage = this.plugin.pages.get(this.centralPagePath);
    if(
      centralPage?.file &&
      !(centralPage.isFolder || centralPage.isTag || centralPage.isVirtual) &&
      this.plugin.settings.autoOpenCentralDocument
    ) {
      if(!this.centralLeaf) {
        this.ea.openFileInNewOrAdjacentLeaf(centralPage.file);
      } else if (
        //@ts-ignore
        this.centralLeaf.view?.file?.path !== centralPage.file.path
      ) {
        this.centralLeaf.openFile(centralPage.file, {active: false});
      }
    }
    await this.render(this.plugin.settings.embedCentralNode);
  }

  private getCentralPage():Page {
    //centralPagePath might no longer be valid in case the user changed the filename of the central page
    //this is relevant only when the central page is embedded, since if the file is in another leaf the leaf.view.file will
    //have the right new path
    let centralPage = this.plugin.pages.get(this.centralPagePath)
    if(!centralPage && this.centralPageFile) {
      this.centralPagePath = this.centralPageFile.path;
      centralPage = this.plugin.pages.get(this.centralPageFile.path);
    }
    return centralPage;
  }

  /** iterates through a neighbour stack and returns the longest title length found.
   * @param Neighbour[]
   * @returns number
   * @description: Possibly time consuming - are there other options? 
  */ 
  private longestTitle(neighbours: Neighbour[], checkMax:number=20): number {
    const lengths:number[] = [0];
    for (let index = 0; (index<neighbours.length) && (index<=checkMax); index++) {
      const item = neighbours[index];
      lengths.push(item.page.getTitle().length);
    }
    return Math.max(...lengths);
  }


  /**
   * Renders the ExcaliBrain graph for the file provided by its path
   * @param path 
   * @returns 
   */
  public async renderGraphForPath(path: string, shouldOpenFile:boolean = true) {
    if(!this.isActive()) {
      return;
    }

    this.blockUpdateTimer = true; //blocks the updateTimer
    const settings = this.plugin.settings;
    const page = this.plugin.pages.get(path);
    if(!page) {
      this.blockUpdateTimer = false;
      return;
    }

    const isFile = !(page.isFolder || page.isTag || page.isVirtual || page.isURL);

    if(isFile && !page.file) {
      this.blockUpdateTimer = false;
      return;
    }

    //abort excalibrain if the file in the Obsidian view has changed
    if(!this.ea.targetView?.file || this.ea.targetView.file.path !== settings.excalibrainFilepath) {
      this.unloadScene();
      return;
    }
    
    //don't render if the user is trying to render the excaliBrain file itself
    if (isFile && (page.file.path === this.ea.targetView.file.path)) { //brainview drawing is the active leaf
      this.blockUpdateTimer = false;
      return; 
    }
  
    keepOnTop(this.plugin.EA);

    const centralPage = this.getCentralPage();
    const isSameFileAsCurrent = centralPage && 
      ((isFile &&  centralPage.file === page.file) ||
       (page.isURL && centralPage.isURL && centralPage.url === page.url))

    // if the file hasn't changed don't update the graph
    if(isSameFileAsCurrent && (page.isURL || (page.file.stat.mtime === centralPage.mtime))) {
      this.blockUpdateTimer = false;
      return; //don't reload the file if it has not changed
    }

    if(isFile && shouldOpenFile && settings.autoOpenCentralDocument) {
      const centralLeaf = this.getCentralLeaf();
      //@ts-ignore
      if(!centralLeaf || !this.app.workspace.getLeafById(centralLeaf.id)) {
        this.centralLeaf = this.ea.openFileInNewOrAdjacentLeaf(page.file);
      } else {
        centralLeaf.openFile(page.file, {active: false});
      }
      this.plugin.navigationHistory.addToHistory(page.file.path);
    } else {
      this.plugin.navigationHistory.addToHistory(page.path);
    }

    if(page.isFolder && !settings.showFolderNodes) {
      settings.showFolderNodes = true;
      this.toolsPanel.rerender();
    }

    if(page.isURL && !settings.showURLNodes) {
      settings.showURLNodes = true;
      this.toolsPanel.rerender();
    }

    if(page.isTag && !settings.showTagNodes) {
      settings.showTagNodes = true;
      this.toolsPanel.rerender();
    }

    this.centralPagePath = path;
    this.centralPageFile = page.file;
    await this.render(isSameFileAsCurrent);
  }

  public static async openExcalidrawLeaf(ea: ExcalidrawAutomate, settings: ExcaliBrainSettings, leaf: WorkspaceLeaf) {
    let counter = 0;

    let file = app.vault.getAbstractFileByPath(settings.excalibrainFilepath);
    if(file && !(file instanceof TFile)) {
      new Notice(`Please check settings. ExcaliBrain path (${settings.excalibrainFilepath}) points to a folder, not a file`);
      return;
    }
    if(!file) {
      file = await app.vault.create(settings.excalibrainFilepath,EMPTYBRAIN);
      //an ugly temporary hack waiting for metadataCache to index the new file
      while(file instanceof TFile && !ea.isExcalidrawFile(file) && counter++<10) {
        await sleep(50);
      }
    }
    counter = 0;
    if(file && file instanceof TFile && !ea.isExcalidrawFile(file)) {
      (new WarningPrompt(
        app,
        "⚠ File Exists",
        `${file.path} already exists in your Vault. Is it ok to overwrite this file? If not, change ExcaliBrain file path in plugin settings.`)
      ).show(async (result: boolean) => {
        if(result) {
          await app.vault.modify(file as TFile,EMPTYBRAIN);
          while(file instanceof TFile && !ea.isExcalidrawFile(file) && counter++<10) {
            await sleep(50);
          }
          Scene.openExcalidrawLeaf(ea, settings, leaf);
        } else {
          new Notice(`Could not start ExcaliBrain. Please change the ExcaliBrain file path in plugin settings.`);
        }
      });
      return;
    }
    if(!leaf) {
      leaf = app.workspace.getLeaf(false);
      if(leaf.getViewState().type !== "empty") {
        leaf = ea.getLeaf(leaf, "new-pane");
      }
    }
    if(settings.defaultAlwaysOnTop && leaf && ea.DEVICE.isDesktop) {
      //@ts-ignore
      const ownerWindow = leaf.view?.ownerWindow;
      if(ownerWindow && (ownerWindow !== window) && !ownerWindow.electronWindow?.isMaximized()) {
        ownerWindow.electronWindow.setAlwaysOnTop(true);
      }
    }
    await leaf.openFile(file as TFile);
  }

  public async initializeScene() {
    this.disregardLeafChange = false;
    const ea = this.ea;
    const settings = this.plugin.settings;
    const style = {
      ...settings.baseNodeStyle,
      ...settings.centralNodeStyle,
    };
    style.textColor = settings.baseNodeStyle.textColor;
    
    let counter = 0;
    ea.clear();    
    ea.setView(this.leaf.view as any);
    //delete existing elements from view. The actual delete will happen when addElementsToView is called
    //I delete them this way to avoid the splash screen flashing up when the scene is cleared
    ea.copyViewElementsToEAforEditing(ea.getViewElements());
    ea.getElements().forEach((el: Mutable<ExcalidrawElement>)=>el.isDeleted=true); 

    while(!ea.targetView.excalidrawAPI && counter++<10) {
      await sleep(50);
    }
    if(!ea.targetView.excalidrawAPI) {
      new Notice(`Error initializing Excalidraw view`);
      return;
    }

    const api = ea.getExcalidrawAPI();
    this.ea.registerThisAsViewEA();
    this.ea.targetView.semaphores.saving = true; //disable saving by setting this Excalidraw flag (not published API)
    api.setMobileModeAllowed(false); //disable mobile view https://github.com/zsviczian/excalibrain/issues/9
    ea.style.fontFamily = style.fontFamily;
    ea.style.fontSize = style.fontSize;
    this.textSize = ea.measureText("m".repeat(style.maxLabelLength));
    this.nodeWidth = this.textSize.width + 2 * style.padding;
    if(this.plugin.settings.compactView) {
      this.nodeWidth = this.nodeWidth * 0.6;
    }
    this.nodeHeight = 2 * (this.textSize.height + 2 * style.padding);

    const frame1 = () => {
      api.updateScene({
        appState: {
          viewModeEnabled:true,
          activeTool: {
            lastActiveToolBeforeEraser: null,
            locked: false,
            type: "selection"
          },
          theme: "light",
        viewBackgroundColor: this.plugin.settings.backgroundColor
        }
      });
    }
    const frame2 = () => {
      ea.style.strokeColor = style.textColor;
      ea.addText(0,0,"🚀 To get started\nselect a document using the search in the top left or\n" +
        "open a document in another pane.\n\n" +
        "✨ For the best experience enable 'Open in adjacent pane'\nin Excalidraw settings " +
        "under 'Links and Transclusion'.\n\n⚠ ExcaliBrain may need to wait for " +
        "DataView to initialize its index.\nThis can take up to a few minutes after starting Obsidian.", {textAlign:"center"});
      ea.addElementsToView(false,false);
      ea.targetView.clearDirty(); //hack to prevent excalidraw from saving the changes
    }
    const frame3 = async () => {
      if(this.plugin.settings.allowAutozoom) {
        setTimeout(()=>api.zoomToFit(null, this.plugin.settings.maxZoom, 0.15),100);
      }
      ea.targetView.linksAlwaysOpenInANewPane = true;
      ea.targetView.allowFrameButtonsInViewMode = true;
      await this.addEventHandler();
      this.historyPanel = new HistoryPanel((this.leaf.view as TextFileView).contentEl.querySelector(".excalidraw"),this.plugin);
      new Notice("ExcaliBrain On");
    }
    frame1();
    frame2();
    frame3();
  }

  addNodes(x:{
    neighbours:Neighbour[],
    layout:Layout,
    isCentral:boolean,
    isSibling:boolean,
    friendGateOnLeft: boolean
  }) {
    x.neighbours.forEach(n => {
      if(n.page.path === this.ea.targetView.file.path) {
        return; 
      }
      n.page.maxLabelLength = x.layout.spec.maxLabelLength;
      const node = new Node({
        ea: this.ea,
        page: n.page,
        isInferred: n.relationType === RelationType.INFERRED,
        isCentral: x.isCentral,
        isSibling: x.isSibling,
        friendGateOnLeft: x.friendGateOnLeft
      });
      this.nodesMap.set(n.page.path,node);
      x.layout.nodes.push(node);
    });
  }

  private getNeighbors(centralPage: Page): {
    parents: Neighbour[],
    children: Neighbour[],
    friends: Neighbour[],
    nextFriends: Neighbour[],
    siblings: Neighbour[]
  } {
    const settings = this.plugin.settings;
    
    //List nodes for the graph
    const parents = centralPage.getParents()
      .filter(x => 
        (x.page.path !== centralPage.path) &&
        !settings.excludeFilepaths.some(p => x.page.path.startsWith(p)) &&
        (!x.page.primaryStyleTag || !this.toolsPanel.linkTagFilter.selectedTags.has(x.page.primaryStyleTag)))
      .slice(0,settings.maxItemCount);
    const parentPaths = parents.map(x=>x.page.path);

    const children =centralPage.getChildren()
      .filter(x => 
        (x.page.path !== centralPage.path) &&
        !settings.excludeFilepaths.some(p => x.page.path.startsWith(p)) &&
        (!x.page.primaryStyleTag || !this.toolsPanel.linkTagFilter.selectedTags.has(x.page.primaryStyleTag)))
      .slice(0,settings.maxItemCount);
    
    const friends = centralPage.getLeftFriends().concat(centralPage.getPreviousFriends())
      .filter(x => 
        (x.page.path !== centralPage.path) &&
        !settings.excludeFilepaths.some(p => x.page.path.startsWith(p)) &&
        (!x.page.primaryStyleTag || !this.toolsPanel.linkTagFilter.selectedTags.has(x.page.primaryStyleTag)))
      .slice(0,settings.maxItemCount);

    const nextFriends = centralPage.getRightFriends().concat(centralPage.getNextFriends())
      .filter(x => 
        (x.page.path !== centralPage.path) &&
        !settings.excludeFilepaths.some(p => x.page.path.startsWith(p)) &&
        (!x.page.primaryStyleTag || !this.toolsPanel.linkTagFilter.selectedTags.has(x.page.primaryStyleTag)))
      .slice(0,settings.maxItemCount);

    const rawSiblings = centralPage
      .getSiblings()
      .filter(s => 
        //the node is not included already as a parent, child, or friend
        !(parents.some(p=>p.page.path === s.page.path)  ||
          children.some(c=>c.page.path === s.page.path) ||
          friends.some(f=>f.page.path === s.page.path)  ||
          nextFriends.some(f=>f.page.path === s.page.path)  ||
          //or not exluded via folder path in settings
          settings.excludeFilepaths.some(p => s.page.path.startsWith(p))
        ) && 
        //it is not the current central page
        (s.page.path !== centralPage.path));

    const siblings = rawSiblings
      .filter(s => 
        //Only display siblings for which the parents are actually displayed.
        //There might be siblings whose parnets have been filtered from view
        s.page.getParents().map(x=>x.page.path).some(y=>parentPaths.includes(y)) &&
        //filter based on primary tag
        (!s.page.primaryStyleTag || !this.toolsPanel.linkTagFilter.selectedTags.has(s.page.primaryStyleTag)))
      .slice(0,settings.maxItemCount);
    return {parents,children,friends,nextFriends,siblings};
  }

  private calculateAreas({
    parents,     parentCols,     parentWidth,
    children,    childrenCols,   childWidth,
    friends,     friendCols,     friendWidth,
    nextFriends, nextFriendCols, nextFriendWidth,
    siblings,    siblingsCols,   siblingsNodeWidth, siblingsNodeHeight
  }:{
    parents: Neighbour[],
    children: Neighbour[],
    friends: Neighbour[],
    nextFriends: Neighbour[],
    siblings: Neighbour[],
    friendCols: number,
    friendWidth: number,
    nextFriendCols: number,
    nextFriendWidth: number,
    parentCols: number,
    parentWidth: number,
    childrenCols: number,
    childWidth: number,
    siblingsNodeWidth: number,
    siblingsCols: number,
    siblingsNodeHeight: number
  }) {
    // layout areas
    const friendsArea = {
      width:  friends.length>0? friendCols*friendWidth:0, 
      height: friends.length>0? Math.ceil(friends.length/friendCols)*this.nodeHeight:0
    }
    const nextFriendsArea = {
      width:  nextFriends.length>0? nextFriendCols*nextFriendWidth:0, 
      height: nextFriends.length>0? Math.ceil(nextFriends.length/nextFriendCols)*this.nodeHeight:0
    }
    const parentsArea = {
      width:  parents.length>0? parentCols*parentWidth:0, 
      height: parents.length>0? Math.ceil(parents.length/parentCols)*this.nodeHeight:0
    }
    const childrenArea = {
      width:  children.length>0? childrenCols*childWidth:0, 
      height: children.length>0? Math.ceil(children.length/childrenCols)*this.nodeHeight:0
    }
    const siblingsArea = {
      width:  siblings.length>0? siblingsNodeWidth*siblingsCols:0, 
      height: siblings.length>0? Math.ceil(siblings.length/siblingsCols)*siblingsNodeHeight:0
    }
    return {friendsArea,nextFriendsArea,parentsArea,childrenArea,siblingsArea};
  }
  
  private calculateLayoutParams({
    centralPage,
    parents,
    children,
    friends,
    nextFriends,
    siblings,
    isCenterEmbedded,
    centerEmbedHeight,
    centerEmbedWidth,
    style,
  }:{
    centralPage: Page, 
    parents: Neighbour[],
    children: Neighbour[],
    friends: Neighbour[],
    nextFriends: Neighbour[],
    siblings: Neighbour[],
    isCenterEmbedded: boolean,
    centerEmbedHeight: number,
    centerEmbedWidth: number,
    style: NodeStyle,
  }) {
    const settings = this.plugin.settings;
    const ea = this.ea;
    const basestyle = settings.baseNodeStyle;

    const isCompactView = settings.compactView;
    const compactFactor = 1.166 * settings.compactingFactor;
    const horizontalFactor = 0.833 * settings.compactingFactor;

    const manyFriends = friends.length >= 10;
    const manyNextFriends = nextFriends.length >= 10;
    const minLabelLength = 7;
    
    const baseChar4x = this.ea.measureText("mi3L".repeat(1));
    const baseChar = {
      width: baseChar4x.width * 0.25,
      height: baseChar4x.height
    };
    this.nodeWidth = basestyle.maxLabelLength * baseChar.width + 2 * basestyle.padding;

    this.nodeHeight = compactFactor * (baseChar.height + 2 * basestyle.padding);
    const padding = 6 * basestyle.padding;
    const prefixLength = 1;

    // container
    const container = ea.targetView.containerEl;
    const h = container.innerHeight-150;
    const w = container.innerWidth;
    const rf = 1/(h/w);
    const rfCorr = Math.min(rf,1);
    
    const correctedMaxLabelLength = Math.round(style.maxLabelLength*rfCorr);
    const correctedMinLabelLength = Math.max(minLabelLength, correctedMaxLabelLength); 

    //columns
    const siblingsCols = siblings.length >= 20
      ? 3
      : siblings.length >= 10
        ? 2
        : 1;
    
    const childrenCols = isCompactView 
      ? children.length <= 12 
        ? [1, 1, 2, 3, 3, 3, 3, 2, 2, 3, 3, 2, 2][children.length]
        : 3
      : children.length <= 12 
        ? [1, 1, 2, 3, 3, 3, 3, 4, 4, 5, 5, 4, 4][children.length]
        : 5;

    const parentCols = isCompactView
      ? (parents.length < 2) ? 1 : 2
      : parents.length < 5
        ? [1, 1, 2, 3, 2][parents.length]
        : 3;;

    const friendCols = isCenterEmbedded
      ? Math.ceil((friends.length*this.nodeHeight)/centerEmbedHeight)
      : manyFriends
        ? 2
        : 1;
  
    const nextFriendCols = isCenterEmbedded
      ? Math.ceil((nextFriends.length*this.nodeHeight)/centerEmbedHeight)
      : manyNextFriends
        ? 2
        : 1;
  
    //center     
    const rootTitle = centralPage.getTitle();
    const rootNode = ea.measureText(rootTitle.repeat(1));
    const actualRootLength = [...new Intl.Segmenter().segment(rootTitle)].length;
    const rootNodeLength = Math.min(actualRootLength + prefixLength, style.maxLabelLength);
    const rootWidth = rootNode.width + 2 * style.padding;
    const heightInCenter = isCenterEmbedded
      ? centerEmbedHeight + 2 * this.nodeHeight
      : 4 *this.nodeHeight;
    
    //parents
    const parentLabelLength = Math.min(this.longestTitle(parents) + prefixLength, correctedMinLabelLength);
    const parentWidth = horizontalFactor * (parentLabelLength * baseChar.width + padding);

    //children
    const childLength = Math.min(this.longestTitle(children,20) + prefixLength, correctedMinLabelLength);
    const childWidth = horizontalFactor * (childLength * baseChar.width + padding);

    // friends
    const friendLength = Math.min(this.longestTitle(friends) + prefixLength,correctedMinLabelLength);
    const friendWidth = horizontalFactor * (friendLength * baseChar.width + padding);

    // nextfriends
    const nextFriendLength = Math.min(this.longestTitle(nextFriends) + prefixLength, correctedMinLabelLength);
    const nextFriendWidth = horizontalFactor * (nextFriendLength * baseChar.width + padding);

    //siblings
    const siblingsStyle = settings.siblingNodeStyle;
    const siblingsPadding = siblingsStyle.padding??settings.baseNodeStyle.padding;
    const siblingsLabelLength = Math.min(this.longestTitle(siblings,20) + prefixLength, correctedMinLabelLength);
    ea.style.fontFamily = siblingsStyle.fontFamily;
    ea.style.fontSize = siblingsStyle.fontSize;
    const siblingsTextSize = ea.measureText("m".repeat(siblingsLabelLength+3));
    const siblingsNodeWidth =  horizontalFactor * (siblingsTextSize.width + 3 * siblingsPadding);
    const siblingsNodeHeight = compactFactor * (siblingsTextSize.height + 2 * siblingsPadding);

    // layout areas
    const {parentsArea,childrenArea,friendsArea,nextFriendsArea,siblingsArea} = this.calculateAreas({
      parents,     parentCols,     parentWidth,
      children,    childrenCols,   childWidth,
      friends,     friendCols,     friendWidth,
      nextFriends, nextFriendCols, nextFriendWidth,
      siblings,    siblingsCols,   siblingsNodeWidth, siblingsNodeHeight
    });
    
    // Origos
    const parentsOrigoY = (parentsArea.height + Math.max(friendsArea.height,nextFriendsArea.height,heightInCenter))*0.5 + padding;
    const childrenOrigoY = (childrenArea.height + Math.max(friendsArea.height,nextFriendsArea.height,heightInCenter))*0.5 + padding;

    const friendOrigoX = Math.max(
        (isCenterEmbedded?centerEmbedWidth:rootWidth) + friendsArea.width, 
        childrenArea.width-friendsArea.width, 
        parentsArea.width-friendsArea.width
      )/2 + padding;
        
    const nextFriendOrigoX = Math.max(
        (isCenterEmbedded?centerEmbedWidth:rootWidth) + nextFriendsArea.width, 
        childrenArea.width-nextFriendsArea.width, 
        parentsArea.width-nextFriendsArea.width
      )/2 + padding;
    
    const siblingsOrigoX = (
      Math.max(
        parentsArea.width,
        (isCenterEmbedded?centerEmbedWidth:rootWidth)
      ) + siblingsArea.width)/2 + 3*siblingsPadding*(1 + siblingsCols);

    const siblingsOrigoY = 
      Math.max(
        parentsOrigoY, 
        (siblingsArea.height + nextFriendsArea.height)/2
      ) + this.nodeHeight;

    return {
      rootNode,                         rootWidth,                             rootNodeLength,
      childrenOrigoY,                   childWidth,                            childLength,         childrenCols,
      parentsOrigoY,                    parentWidth,                           parentLabelLength,   parentCols,
      friendOrigoX,                     friendWidth,                           friendLength,        friendCols,
      nextFriendOrigoX,                 nextFriendWidth,                       nextFriendLength,    nextFriendCols,
      siblingsOrigoX,   siblingsOrigoY, siblingsNodeWidth, siblingsNodeHeight, siblingsLabelLength, siblingsCols,
    };
  }

  /**
   * if retainCentralNode is true, the central node is not removed from the scene when the scene is rendered
   * this will ensure that the embedded frame in the center is not reloaded
   * @param retainCentralNode 
   * @returns 
   */
  private async render(retainCentralNode:boolean = false) {
    if(this.historyPanel) {
      this.historyPanel.rerender()
    }
    if(!this.centralPagePath) return;

    const settings = this.plugin.settings;
    
    let centralPage = this.plugin.pages.get(this.centralPagePath);
    if(!centralPage) {
      //path case sensitivity issue
      this.centralPagePath = this.plugin.lowercasePathMap.get(this.centralPagePath.toLowerCase());
      centralPage = this.plugin.pages.get(this.centralPagePath);
      if(!centralPage) return;
      this.centralPageFile = centralPage.file;
    }

    const ea = this.ea;
    retainCentralNode = 
      retainCentralNode && Boolean(this.rootNode) &&
      settings.embedCentralNode && ((centralPage.file && isEmbedFileType(centralPage.file,ea)) || centralPage.isURL);

    this.zoomToFitOnNextBrainLeafActivate = !ea.targetView.containerEl.isShown();

    ea.clear();
    ea.copyViewElementsToEAforEditing(ea.getViewElements());
    //delete existing elements from view. The actual delete will happen when addElementsToView is called
    //I delete them this way to avoid the splash screen flashing up when the scene is cleared
    //https://github.com/zsviczian/obsidian-excalidraw-plugin/issues/1248#event-9940972555
    ea.getElements()
      .filter((el: ExcalidrawElement)=>!retainCentralNode || !this.rootNode.embeddedElementIds.includes(el.id))
      .forEach((el: Mutable<ExcalidrawElement>)=>el.isDeleted=true);
    ea.style.verticalAlign = "middle";

    const {parents,children,friends,nextFriends,siblings} = this.getNeighbors(centralPage);

    //-------------------------------------------------------
    // Generate layout and nodes
    this.nodesMap = new Map<string,Node>();
    this.links = new Links(this.plugin);
    this.layouts = [];

    const isCenterEmbedded = 
      settings.embedCentralNode &&
      !centralPage.isVirtual &&
      !centralPage.isFolder &&
      !centralPage.isTag;
    const centerEmbedWidth = settings.centerEmbedWidth;
    const centerEmbedHeight = settings.centerEmbedHeight;

    const style = {
      ...settings.baseNodeStyle,
      ...settings.centralNodeStyle,
    };
    const basestyle = settings.baseNodeStyle;
    ea.style.fontFamily = basestyle.fontFamily;
    ea.style.fontSize = basestyle.fontSize;

    const {
      rootNode, rootWidth, rootNodeLength,
      childrenOrigoY, childWidth, childLength, childrenCols,
      parentsOrigoY, parentWidth, parentLabelLength, parentCols,
      friendOrigoX, friendWidth, friendLength, friendCols,
      nextFriendOrigoX, nextFriendWidth, nextFriendLength, nextFriendCols,
      siblingsOrigoX, siblingsOrigoY, siblingsNodeWidth, siblingsNodeHeight, siblingsLabelLength, siblingsCols,
    } = this.calculateLayoutParams({
      centralPage,
      parents, children, friends, nextFriends, siblings,
      isCenterEmbedded, centerEmbedHeight, centerEmbedWidth,
      style,
    });
 
    // layout    
    const lCenter = new Layout({
      origoX: 0,
      origoY: isCenterEmbedded
        ? centerEmbedHeight/2 - this.nodeHeight/2
        : 0,
      top: null,
      bottom: null,
      columns: 1,
      columnWidth: isCenterEmbedded
        ? centerEmbedWidth
        : rootWidth,
      rowHeight: isCenterEmbedded
        ? centerEmbedHeight
        : rootNode.height,
        maxLabelLength: rootNodeLength
    });
    this.layouts.push(lCenter);

    const lChildren = new Layout({
      origoX: 0,
      origoY: childrenOrigoY,
      top: 0,
      bottom: null,
      columns: childrenCols,
      columnWidth: childWidth,
      rowHeight: this.nodeHeight,
      maxLabelLength: childLength
    });
    this.layouts.push(lChildren);
    
    const lFriends = new Layout({
      origoX: -friendOrigoX,
      origoY: 0,
      top: null,
      bottom: null,
      columns: friendCols,
      columnWidth: friendWidth,
      rowHeight: this.nodeHeight,
      maxLabelLength: friendLength
    });
    this.layouts.push(lFriends);

    const lNextFriends = new Layout({
      origoX: nextFriendOrigoX,
      origoY: 0,
      top: null,
      bottom: null,
      columns: nextFriendCols,
      columnWidth: nextFriendWidth,
      rowHeight: this.nodeHeight,
      maxLabelLength: nextFriendLength
    });
    this.layouts.push(lNextFriends);
    
    const lParents = new Layout({
      origoX:0,
      origoY: - parentsOrigoY,
      top: null,
      bottom: -2 * this.nodeHeight,
      columns: parentCols, // 3,
      columnWidth: parentWidth,
      rowHeight: this.nodeHeight,
      maxLabelLength: parentLabelLength
    });
    this.layouts.push(lParents);

    const lSiblings = new Layout({
      //origoX: this.nodeWidth * ((parentCols-1)/2 + (siblingsCols+1.5)/3), //orig
      origoX: siblingsOrigoX,
      origoY: - siblingsOrigoY,
      top: null,
      bottom: null,
      columns: siblingsCols, 
      columnWidth: siblingsNodeWidth,
      rowHeight: siblingsNodeHeight,
      maxLabelLength: siblingsLabelLength
    })
    this.layouts.push(lSiblings);

    centralPage.maxLabelLength = rootNodeLength; 
    this.rootNode = new Node({
      ea,
      page: centralPage,
      isInferred: false,
      isCentral: true,
      isSibling: false,
      friendGateOnLeft: true,
      isEmbeded: isCenterEmbedded,
      embeddedElementIds: retainCentralNode ? this.rootNode?.embeddedElementIds : undefined,
    });

    this.nodesMap.set(centralPage.path,this.rootNode);
    lCenter.nodes.push(this.rootNode);
  
    this.addNodes({
      neighbours: parents,
      layout: lParents,
      isCentral: false,
      isSibling: false,
      friendGateOnLeft: true
    });
  
    this.addNodes({
      neighbours: children,
      layout: lChildren,
      isCentral: false,
      isSibling: false,
      friendGateOnLeft: true
    });
  
    this.addNodes({
      neighbours: friends,
      layout: lFriends,
      isCentral: false,
      isSibling: false,
      friendGateOnLeft: false
    });

    this.addNodes({
      neighbours: nextFriends,
      layout: lNextFriends,
      isCentral: false,
      isSibling: false,
      friendGateOnLeft: true
    });

    if(settings.renderSiblings) {
      this.addNodes({
        neighbours: siblings,
        layout: lSiblings,
        isCentral: false,
        isSibling: true,
        friendGateOnLeft: true
      });
    }

    //-------------------------------------------------------
    // Generate links for all displayed nodes
    const addLinks = (nodeA: Node, neighbours:Neighbour[],role: Role) => {
      neighbours.forEach(neighbour=>{
        const nodeB = this.nodesMap.get(neighbour.page.path);
        if(!nodeB) {
          return;
        }
        this.links.addLink(
          nodeA,
          nodeB,
          role,
          neighbour.relationType,
          neighbour.typeDefinition,
          neighbour.linkDirection,
          ea,
          settings
        )
      })
    }

    Array.from(this.nodesMap.values()).forEach(nodeA => {
      addLinks(nodeA, nodeA.page.getChildren(),Role.CHILD);
      addLinks(nodeA, nodeA.page.getParents(),Role.PARENT);
      addLinks(nodeA, nodeA.page.getLeftFriends(),Role.LEFT);
      addLinks(nodeA, nodeA.page.getPreviousFriends(),Role.LEFT);
      addLinks(nodeA, nodeA.page.getRightFriends(),Role.RIGHT);
      addLinks(nodeA, nodeA.page.getNextFriends(),Role.RIGHT);
    });
  
    //-------------------------------------------------------
    // Render
    ea.style.opacity = 100;
    await Promise.all(this.layouts.map(async (layout) => await layout.render()));
    const nodeElements = ea.getElements();
    this.links.render(Array.from(this.toolsPanel.linkTagFilter.selectedLinks));
    
    const linkElements = ea.getElements().filter(el=>!nodeElements.includes(el));


    //hack to send link elements behind node elements
    const newImagesDict = linkElements.concat(nodeElements) 
      .reduce((dict:{[key:string]:any}, obj:ExcalidrawElement) => {
        dict[obj.id] = obj;
        return dict;
      }, {});

    ea.elementsDict = newImagesDict;

    const excalidrawAPI = ea.getExcalidrawAPI() as ExcalidrawImperativeAPI;
    ea.addElementsToView(false,false);
    excalidrawAPI.updateScene({appState: {viewBackgroundColor: settings.backgroundColor}});
    ea.targetView.clearDirty(); //hack to prevent excalidraw from saving the changes
    if(settings.allowAutozoom && !retainCentralNode) {
      setTimeout(()=>excalidrawAPI.zoomToFit(ea.getViewElements(),settings.maxZoom,0.15),100);
    }
  
    this.toolsPanel.rerender();
    if(this.focusSearchAfterInitiation && settings.allowAutofocuOnSearch) {
      this.toolsPanel.searchElement.focus();
      this.focusSearchAfterInitiation = false;
    }

    this.blockUpdateTimer = false;
  }

  public isCentralLeafStillThere():boolean {
    const settings = this.plugin.settings;
    //@ts-ignore
    const noCentralLeaf = app.workspace.getLeafById(this.centralLeaf.id) === null ;
    if(noCentralLeaf) {
      return false;
    }
    //@ts-ignore
    if (this.centralLeaf.view?.file?.path === settings.excalibrainFilepath) {
      return false;
    }
    return true;
  }

  private async brainEventHandler (leaf:WorkspaceLeaf, startup:boolean = false) {
    const settings = this.plugin.settings;
    
    if(!this.ea.targetView?.file || this.ea.targetView.file.path !== settings.excalibrainFilepath) {
      this.unloadScene();
      return;
    }

    if(this.disregardLeafChange) {
      return;
    }

    if(!startup && !settings.autoOpenCentralDocument) {
      return;
    }

    this.blockUpdateTimer = true;
    await sleep(100);

    //-------------------------------------------------------
    //terminate event handler if view no longer exists or file has changed

    if(this.pinLeaf && !this.isCentralLeafStillThere()) {
      this.pinLeaf = false;
      this.toolsPanel.rerender();
    }

    if(this.pinLeaf && leaf !== this.centralLeaf) return;
    
    if(!(leaf?.view && (leaf.view instanceof FileView) && leaf.view.file)) {
      this.blockUpdateTimer = false;
      return;
    }

    const rootFile = leaf.view.file;
    
    if (rootFile.path === this.ea.targetView.file.path) { //brainview drawing is the active leaf
      if(this.vaultFileChanged) {
        this.zoomToFitOnNextBrainLeafActivate = false;
        await this.reRender(true);
      }
      if(this.zoomToFitOnNextBrainLeafActivate) {
        this.zoomToFitOnNextBrainLeafActivate = false;
        if(settings.allowAutozoom) {
          this.ea.getExcalidrawAPI().zoomToFit(null, settings.maxZoom, 0.15);
        }
      }
      this.blockUpdateTimer = false;
      return; 
    }
  
    const centralPage = this.getCentralPage();
    if(
      centralPage &&
      centralPage.path === rootFile.path &&
      rootFile.stat.mtime === centralPage.mtime
    ) {
      this.blockUpdateTimer = false;
      return; //don't reload the file if it has not changed
    }

    if(!this.plugin.pages.get(rootFile.path)) {
      await this.plugin.createIndex();
    }

    this.plugin.navigationHistory.addToHistory(rootFile.path);
    this.centralPagePath = rootFile.path;
    this.centralPageFile = rootFile;
    this.centralLeaf = leaf;
    this.render();
  }

  private async addEventHandler() {
    const fileChangeHandler = () => {
      this.vaultFileChanged = true;
    }

    const beh = (leaf:WorkspaceLeaf)=>this.brainEventHandler(leaf);
    this.app.workspace.on("active-leaf-change", beh);
    this.removeEH = () => app.workspace.off("active-leaf-change",beh);
    this.setTimer();
    this.app.vault.on("rename",fileChangeHandler);
    this.removeOnRename = () => app.vault.off("rename",fileChangeHandler)
    this.app.vault.on("modify",fileChangeHandler);
    this.removeOnModify = () => app.vault.off("modify",fileChangeHandler)
    this.app.vault.on("create",fileChangeHandler);
    this.removeOnCreate = () => app.vault.off("create",fileChangeHandler)
    this.app.vault.on("delete",fileChangeHandler);
    this.removeOnDelete = () => app.vault.off("delete",fileChangeHandler)

    const leaves: WorkspaceLeaf[] = [];
    app.workspace.iterateAllLeaves(l=>{
      if( (l.view instanceof FileView) && l.view.file && l.view.file.path !== this.ea.targetView.file.path) {
        leaves.push(l);
      }
    })
    
    await this.plugin.createIndex(); //temporary
    
    let leafToOpen = leaves[0];
    if(leaves.length>0) {
      const lastFilePath = app.workspace.getLastOpenFiles()[0];
      if(lastFilePath && lastFilePath !== "") {
        const leaf = leaves.filter(l=>(l.view as FileView)?.file.path === lastFilePath);
        if(leaf.length>0) {
          leafToOpen = leaf[0];
        }
      }
      keepOnTop(this.plugin.EA);  
      this.brainEventHandler(leafToOpen, true);
    } else {
      if(this.plugin.navigationHistory.length>0) {
        const lastFilePath = this.plugin.navigationHistory.last;
        setTimeout(()=>this.renderGraphForPath(lastFilePath,true),100);
      }
    }
  }

  setTimer() {
    const updateTimer = async () => {
      if(this.blockUpdateTimer) {
        return;
      }
      if(this.vaultFileChanged) {
        this.vaultFileChanged = false;
        await this.plugin.createIndex();
        if(this.centralPagePath) {
          const centralPage = this.getCentralPage();
          if(!centralPage) {
            //@ts-ignore
            if(this.centralLeaf && this.centralLeaf.view && this.centralLeaf.view.file) {
              //@ts-ignore
              this.centralPageFile = this.centralLeaf.view.file;
              this.centralPagePath = this.centralPageFile.path;
            }
          }
        }
        this.render(true);
      }
    }

    if(this.removeTimer) {
      this.removeTimer();
      this.removeTimer = undefined;
    }

    const timer = setInterval(updateTimer,this.plugin.settings.indexUpdateInterval);
    this.removeTimer = () => clearInterval(timer);
  }


  public unloadScene(saveSettings:boolean = true, silent: boolean = false) {
    if(this.removeEH) {
      this.removeEH();
      this.removeEH = undefined;
    }

    if(this.removeTimer) {
      this.removeTimer();
      this.removeTimer = undefined;
    }

    if(this.removeOnRename) {
      this.removeOnRename();
      this.removeOnRename = undefined;
    }
    
    if(this.removeOnModify) {
      this.removeOnModify();
      this.removeOnModify = undefined;
    }

    if(this.removeOnCreate) {
      this.removeOnCreate();
      this.removeOnCreate = undefined;
    }
    
    if(this.removeOnDelete) {
      this.removeOnDelete();
      this.removeOnDelete = undefined;
    }

    if(this.ea.targetView && isBoolean(this.ea.targetView.linksAlwaysOpenInANewPane)) {
      this.ea.targetView.linksAlwaysOpenInANewPane = false;
    }
    
    if(this.ea.targetView && isBoolean(this.ea.targetView.allowFrameButtonsInViewMode)) {
      this.ea.targetView.allowFrameButtonsInViewMode = false;
    }

    if(this.ea.targetView && this.ea.targetView.excalidrawAPI) {
      try {
        this.ea.targetView.semaphores.saving = false;
        this.ea.targetView.excalidrawAPI.setMobileModeAllowed(true);
        this.ea.targetView.excalidrawAPI.updateScene({appState:{viewModeEnabled:false}});
      } catch {}
    }
    //@ts-ignore
    if(this.ea.targetView && this.ea.targetView._loaded) {
      try {
        this.ea.deregisterThisAsViewEA();
      } catch {}
    }
    // timout is to make sure Obsidian is not being terminated when scene closes,
    // becasue that can lead to crippled settings file
    // if the plugin is still there after 400ms, it is safe to save the settings
    if(saveSettings) {
      setTimeout(async () => {
        await this.plugin.loadSettings(); //only overwrite the navigation history, save other synchronized settings
        this.plugin.settings.navigationHistory = [...this.plugin.navigationHistory.get()];
        await this.plugin.saveSettings();
      },400);
    }
    this.toolsPanel?.terminate();
    this.toolsPanel = undefined;
    this.historyPanel?.terminate();
    this.historyPanel = undefined;
    this.ea.targetView = undefined;
    this.leaf = undefined;
    this.centralLeaf = undefined;
    this.centralPagePath = undefined;
    this.centralPageFile = undefined;
    this.terminated = true;
    //@ts-ignore
    if(!this.app.plugins.plugins["obsidian-excalidraw-plugin"]) {
      this.plugin.EA = null;
    }
    if(!silent) {
      new Notice("Brain Graph Off");
    }
    const mostRecentLeaf = this.app.workspace.getMostRecentLeaf();
    if(mostRecentLeaf) {
      this.app.workspace.setActiveLeaf(
        mostRecentLeaf,
        { focus: true },
      )
    }
  }
}
