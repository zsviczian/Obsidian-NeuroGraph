import { LayoutSpecification } from "src/types";
import {Node} from "./Node";

export class Layout {
  nodes: Node[] = [];
  renderedNodes: Node[][] = [];
  spec: LayoutSpecification;

  constructor(spec: LayoutSpecification) {
    this.spec = spec;
  }

  layout(columns = this.spec.columns) {
    const generateOddLayoutVector = (pattern:number[]) => {
      const res:number[] = [];
      let cur = 1;
      let state = true;
      pattern
        .map(p => Math.floor(p))
        .forEach(cnt => {
          for(let i=0;i<cnt;i++) res.push(state ? null : cur++);
          state = !state;
        });
      return res;
    }

    const generateEvenLayoutVector = (pattern: number[]) => {
      const res:number[] = [];
      let i = 0;
      for(i=columns/2;i>pattern[0];i--) res.push(null);
      for(i=0;i<pattern[0];i++) res.push(i+1);
      for (i=0;i<columns/2;i++) res.push(i<pattern[1]?pattern[0]+i+1:null);
      return res;
    }
  
    const getRowLayout = (items: number) => columns%2
      ? (items%2 //even columns
        ? generateEvenLayoutVector([(items+1)/2,(items-1)/2]) //odd
        : generateEvenLayoutVector([items/2,items/2])) //even
      : (items%2 //odd columns
        ? generateOddLayoutVector([(columns-items)/2,items,(columns-items)/2]) //odd
        : generateOddLayoutVector([(columns-items)/2,items/2,1,items/2,(columns-items)/2])); //even
    
    const sortedNodes = this.nodes.sort((a,b) => a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1)
    const itemCount = sortedNodes.length;
    if(itemCount === 0) {
      return;
    }
    const rowCount = Math.ceil(itemCount / columns);

    this.renderedNodes = Array<Node>(rowCount).fill(null).map((_,i) =>
      (i+1 < rowCount) || (itemCount % columns === 0)
        ? Array(columns).fill(null).map((_,j) => sortedNodes[i*columns+j]) //full row
        : getRowLayout(itemCount % columns).map(idx => idx ? sortedNodes[i*columns+idx-1]:null));
  }


  async render() {
    this.layout();
    const rows = this.renderedNodes.length;
    const height = rows * this.spec.rowHeight;
    const top = (this.spec.top === null && this.spec.bottom === null) //unconstrained
      ? this.spec.origoY - height/2
      : this.spec.top !== null 
        ? (this.spec.origoY - height/2) < this.spec.top //top constrained
          ? this.spec.top
          : this.spec.origoY - height/2
        : (this.spec.origoY + height/2) > this.spec.bottom  //bottom constrained
          ? this.spec.bottom - height
          : this.spec.origoY - height/2;
    const center00 = {
      x: this.spec.origoX - (this.spec.columns === 1 ? 0 : (this.spec.columns-1)/2*this.spec.columnWidth),
      y: top
    };
    for (const [row, nodes] of this.renderedNodes.entries()) {
      for (const [idx, node] of nodes.entries()) {
        if(node) {
          node.setCenter({
            x: center00.x + idx*this.spec.columnWidth,
            y: center00.y + row*this.spec.rowHeight
          });
          await node.render();
        }
      }
    }
  }
}
