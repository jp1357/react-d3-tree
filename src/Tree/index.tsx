import React, { SyntheticEvent } from 'react';
import { tree as d3tree, hierarchy, HierarchyPointNode } from 'd3-hierarchy';
import { select, event } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';
import { dequal as deepEqual } from 'dequal/lite';
import clone from 'clone';
import { v4 as uuidv4 } from 'uuid';

import TransitionGroupWrapper from './TransitionGroupWrapper';
import Node from '../Node';
import Link from '../Link';
import { TreeNodeDatum, Point, RawNodeDatum } from '../types/common';
import { TreeLinkEventCallback, TreeProps } from './types';
import globalCss from '../globalCss';

type TreeState = {
  dataRef: TreeProps['data'];
  data: TreeNodeDatum[];
  d3: { translate: Point; scale: number };
  isTransitioning: boolean;
  isInitialRenderForDataset: boolean;
};

const rd3tSvgClassName = 'rd3t-svg';
const rd3tGClassName = 'rd3t-g';

class Tree extends React.Component<TreeProps, TreeState> {
  static defaultProps: Partial<TreeProps> = {
    onNodeClick: undefined,
    onNodeMouseOver: undefined,
    onNodeMouseOut: undefined,
    onLinkClick: undefined,
    onLinkMouseOver: undefined,
    onLinkMouseOut: undefined,
    onUpdate: undefined,
    orientation: 'horizontal',
    translate: { x: 0, y: 0 },
    pathFunc: 'diagonal',
    pathClassFunc: undefined,
    transitionDuration: 500,
    depthFactor: undefined,
    collapsible: true,
    initialDepth: undefined,
    zoomable: true,
    zoom: 1,
    scaleExtent: { min: 0.1, max: 1 },
    nodeSize: { x: 140, y: 140 },
    separation: { siblings: 1, nonSiblings: 2 },
    shouldCollapseNeighborNodes: false,
    svgClassName: '',
    rootNodeClassName: '',
    branchNodeClassName: '',
    leafNodeClassName: '',
    renderCustomNodeElement: undefined,
    enableLegacyTransitions: false,
  };

  state: TreeState = {
    dataRef: this.props.data,
    data: Tree.assignInternalProperties(clone(this.props.data)),
    d3: Tree.calculateD3Geometry(this.props),
    isTransitioning: false,
    isInitialRenderForDataset: true,
  };

  private internalState = {
    targetNode: null,
    isTransitioning: false,
  };

  static getDerivedStateFromProps(nextProps: TreeProps, prevState: TreeState) {
    let derivedState: Partial<TreeState> = null;
    // Clone new data & assign internal properties if `data` object reference changed.
    if (nextProps.data !== prevState.dataRef) {
      derivedState = {
        dataRef: nextProps.data,
        data: Tree.assignInternalProperties(clone(nextProps.data)),
        isInitialRenderForDataset: true,
      };
    }
    const d3 = Tree.calculateD3Geometry(nextProps);
    if (!deepEqual(d3, prevState.d3)) {
      derivedState = derivedState || {};
      derivedState.d3 = d3;
    }
    return derivedState;
  }

  componentDidMount() {
    this.bindZoomListener(this.props);
    this.setState({ isInitialRenderForDataset: false });
  }

  componentDidUpdate(prevProps: TreeProps) {
    if (this.props.data !== prevProps.data) {
      // If last `render` was due to change in dataset -> mark the initial render as done.
      this.setState({ isInitialRenderForDataset: false });
    }

    if (
      !deepEqual(this.props.translate, prevProps.translate) ||
      !deepEqual(this.props.scaleExtent, prevProps.scaleExtent) ||
      this.props.zoom !== prevProps.zoom ||
      this.props.enableLegacyTransitions !== prevProps.enableLegacyTransitions
    ) {
      // If zoom-specific props change -> rebind listener with new values.
      // Or: rebind zoom listeners to new DOM nodes in case legacy transitions were enabled/disabled.
      this.bindZoomListener(this.props);
    }

    if (typeof this.props.onUpdate === 'function') {
      this.props.onUpdate({
        node: this.internalState.targetNode ? clone(this.internalState.targetNode) : null,
        zoom: this.state.d3.scale,
        translate: this.state.d3.translate,
      });
    }
    // Reset the last target node after we've flushed it to `onUpdate`.
    this.internalState.targetNode = null;
  }

  /**
   * Collapses all tree nodes with a `depth` larger than `initialDepth`.
   *
   * @param {array} nodeSet Array of nodes generated by `generateTree`
   * @param {number} initialDepth Maximum initial depth the tree should render
   */
  setInitialTreeDepth(nodeSet: HierarchyPointNode<TreeNodeDatum>[], initialDepth: number) {
    nodeSet.forEach(n => {
      n.data.__rd3t.collapsed = n.depth >= initialDepth;
    });
  }

  /**
   * bindZoomListener - If `props.zoomable`, binds a listener for
   * "zoom" events to the SVG and sets scaleExtent to min/max
   * specified in `props.scaleExtent`.
   */
  bindZoomListener(props: TreeProps) {
    const { zoomable, scaleExtent, translate, zoom, onUpdate } = props;
    const svg = select(`.${rd3tSvgClassName}`);
    const g = select(`.${rd3tGClassName}`);
    if (zoomable) {
      // Sets initial offset, so that first pan and zoom does not jump back to default [0,0] coords.
      // @ts-ignore
      svg.call(d3zoom().transform, zoomIdentity.translate(translate.x, translate.y).scale(zoom));
      svg.call(
        d3zoom()
          .scaleExtent([scaleExtent.min, scaleExtent.max])
          // TODO: break this out into a separate zoom handler fn, rather than inlining it.
          .on('zoom', () => {
            g.attr('transform', event.transform);
            if (typeof onUpdate === 'function') {
              // This callback is magically called not only on "zoom", but on "drag", as well,
              // even though event.type == "zoom".
              // Taking advantage of this and not writing a "drag" handler.
              onUpdate({
                node: null,
                zoom: event.transform.k,
                translate: { x: event.transform.x, y: event.transform.y },
              });
              // TODO: remove this? Shouldn't be mutating state keys directly.
              this.state.d3.scale = event.transform.k;
              this.state.d3.translate = {
                x: event.transform.x,
                y: event.transform.y,
              };
            }
          })
      );
    }
  }

  /**
   * Assigns internal properties that are required for tree
   * manipulation to each node in the `data` set and returns a new `data` array.
   *
   * @static
   */
  static assignInternalProperties(data: RawNodeDatum[], currentDepth: number = 0): TreeNodeDatum[] {
    // Wrap the root node into an array for recursive transformations if it wasn't in one already.
    const d = Array.isArray(data) ? data : [data];
    return d.map(n => {
      const nodeDatum = n as TreeNodeDatum;
      nodeDatum.__rd3t = { id: null, depth: null, collapsed: false };
      nodeDatum.__rd3t.id = uuidv4();
      // D3@v5 compat: manually assign `depth` to node.data so we don't have
      // to hold full node+link sets in state.
      // TODO: avoid this extra step by checking D3's node.depth directly.
      nodeDatum.__rd3t.depth = currentDepth;
      // If there are children, recursively assign properties to them too.
      if (nodeDatum.children && nodeDatum.children.length > 0) {
        nodeDatum.children = Tree.assignInternalProperties(nodeDatum.children, currentDepth + 1);
      }
      return nodeDatum;
    });
  }

  /**
   * Recursively walks the nested `nodeSet` until a node matching `nodeId` is found.
   */
  findNodesById(nodeId: string, nodeSet: TreeNodeDatum[], hits: TreeNodeDatum[]) {
    if (hits.length > 0) {
      return hits;
    }
    hits = hits.concat(nodeSet.filter(node => node.__rd3t.id === nodeId));
    nodeSet.forEach(node => {
      if (node.children && node.children.length > 0) {
        hits = this.findNodesById(nodeId, node.children, hits);
      }
    });
    return hits;
  }

  /**
   * Recursively walks the nested `nodeSet` until all nodes at `depth` have been found.
   *
   * @param {number} depth Target depth for which nodes should be returned
   * @param {array} nodeSet Array of nested `node` objects
   * @param {array} accumulator Accumulator for matches, passed between recursive calls
   */
  findNodesAtDepth(depth: number, nodeSet: TreeNodeDatum[], accumulator: TreeNodeDatum[]) {
    accumulator = accumulator.concat(nodeSet.filter(node => node.__rd3t.depth === depth));
    nodeSet.forEach(node => {
      if (node.children && node.children.length > 0) {
        accumulator = this.findNodesAtDepth(depth, node.children, accumulator);
      }
    });
    return accumulator;
  }

  /**
   * Recursively sets the internal `collapsed` property of
   * the passed `TreeNodeDatum` and its children to `true`.
   *
   * @static
   */
  static collapseNode(nodeDatum: TreeNodeDatum) {
    nodeDatum.__rd3t.collapsed = true;
    if (nodeDatum.children && nodeDatum.children.length > 0) {
      nodeDatum.children.forEach(child => {
        Tree.collapseNode(child);
      });
    }
  }

  /**
   * Sets the internal `collapsed` property of
   * the passed `TreeNodeDatum` object to `false`.
   *
   * @static
   */
  static expandNode(nodeDatum: TreeNodeDatum) {
    nodeDatum.__rd3t.collapsed = false;
  }

  /**
   * Collapses all nodes in `nodeSet` that are neighbors (same depth) of `targetNode`.
   */
  collapseNeighborNodes(targetNode: TreeNodeDatum, nodeSet: TreeNodeDatum[]) {
    const neighbors = this.findNodesAtDepth(targetNode.__rd3t.depth, nodeSet, []).filter(
      node => node.__rd3t.id !== targetNode.__rd3t.id
    );
    neighbors.forEach(neighbor => Tree.collapseNode(neighbor));
  }

  /**
   * Finds the node matching `nodeId` and
   * expands/collapses it, depending on the current state of
   * its internal `collapsed` property.
   * `setState` callback receives targetNode and handles
   * `props.onClick` if defined.
   */
  handleNodeToggle = (nodeId: string) => {
    const data = clone(this.state.data);
    const matches = this.findNodesById(nodeId, data, []);
    const targetNodeDatum = matches[0];

    if (this.props.collapsible && !this.state.isTransitioning) {
      if (targetNodeDatum.__rd3t.collapsed) {
        Tree.expandNode(targetNodeDatum);
        this.props.shouldCollapseNeighborNodes && this.collapseNeighborNodes(targetNodeDatum, data);
      } else {
        Tree.collapseNode(targetNodeDatum);
      }

      if (this.props.enableLegacyTransitions) {
        // Lock node toggling while transition takes place.
        this.setState({ data, isTransitioning: true });
        // Await transitionDuration + 10 ms before unlocking node toggling again.
        setTimeout(
          () => this.setState({ isTransitioning: false }),
          this.props.transitionDuration + 10
        );
      } else {
        this.setState({ data });
      }

      this.internalState.targetNode = targetNodeDatum;
    }
  };

  /**
   * Handles the user-defined `onNodeClick` function.
   */
  handleOnNodeClickCb = (nodeId: string, evt: SyntheticEvent) => {
    const { onNodeClick } = this.props;
    if (onNodeClick && typeof onNodeClick === 'function') {
      const data = clone(this.state.data);
      const matches = this.findNodesById(nodeId, data, []);
      const targetNode = matches[0];
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onNodeClick(clone(targetNode), evt);
    }
  };

  /**
   * Handles the user-defined `onLinkClick` function.
   */
  handleOnLinkClickCb: TreeLinkEventCallback = (linkSource, linkTarget, evt) => {
    const { onLinkClick } = this.props;
    if (onLinkClick && typeof onLinkClick === 'function') {
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onLinkClick(clone(linkSource), clone(linkTarget), evt);
    }
  };

  /**
   * Handles the user-defined `onNodeMouseOver` function.
   */
  handleOnNodeMouseOverCb = (nodeId: string, evt: SyntheticEvent) => {
    const { onNodeMouseOver } = this.props;
    if (onNodeMouseOver && typeof onNodeMouseOver === 'function') {
      const data = clone(this.state.data);
      const matches = this.findNodesById(nodeId, data, []);
      const targetNode = matches[0];
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onNodeMouseOver(clone(targetNode), evt);
    }
  };

  /**
   * Handles the user-defined `onLinkMouseOver` function.
   */
  handleOnLinkMouseOverCb: TreeLinkEventCallback = (linkSource, linkTarget, evt) => {
    const { onLinkMouseOver } = this.props;
    if (onLinkMouseOver && typeof onLinkMouseOver === 'function') {
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onLinkMouseOver(clone(linkSource), clone(linkTarget), evt);
    }
  };

  /**
   * Handles the user-defined `onNodeMouseOut` function.
   */
  handleOnNodeMouseOutCb = (nodeId: string, evt: SyntheticEvent) => {
    const { onNodeMouseOut } = this.props;
    if (onNodeMouseOut && typeof onNodeMouseOut === 'function') {
      const data = clone(this.state.data);
      const matches = this.findNodesById(nodeId, data, []);
      const targetNode = matches[0];
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onNodeMouseOut(clone(targetNode), evt);
    }
  };

  /**
   * Handles the user-defined `onLinkMouseOut` function.
   */
  handleOnLinkMouseOutCb: TreeLinkEventCallback = (linkSource, linkTarget, evt) => {
    const { onLinkMouseOut } = this.props;
    if (onLinkMouseOut && typeof onLinkMouseOut === 'function') {
      // Persist the SyntheticEvent for downstream handling by users.
      evt.persist();
      onLinkMouseOut(clone(linkSource), clone(linkTarget), evt);
    }
  };

  /**
   * Generates tree elements (`nodes` and `links`) by
   * grabbing the rootNode from `this.state.data[0]`.
   * Restricts tree depth to `props.initialDepth` if defined and if this is
   * the initial render of the tree.
   */
  generateTree() {
    const { initialDepth, depthFactor, separation, nodeSize, orientation } = this.props;
    const { isInitialRenderForDataset } = this.state;
    const tree = d3tree<TreeNodeDatum>()
      .nodeSize(orientation === 'horizontal' ? [nodeSize.y, nodeSize.x] : [nodeSize.x, nodeSize.y])
      .separation((a, b) =>
        a.parent.data.__rd3t.id === b.parent.data.__rd3t.id
          ? separation.siblings
          : separation.nonSiblings
      );

    const rootNode = tree(
      hierarchy(this.state.data[0], d => {
        if (initialDepth !== undefined && isInitialRenderForDataset) {
          // If `initialDepth` is defined, a node's depth determines
          // whether we append `children` on the first render.
          return d.__rd3t.depth >= initialDepth ? null : d.children;
        } else {
          // Node's `collapsed` property determines appending of `children` for subsequent renders.
          return d.__rd3t.collapsed ? null : d.children;
        }
      })
    );
    let nodes = rootNode.descendants();
    const links = rootNode.links();

    // Configure nodes' `collapsed` property on first render if `initialDepth` is defined.
    if (initialDepth !== undefined && isInitialRenderForDataset) {
      this.setInitialTreeDepth(nodes, initialDepth);
    }

    if (depthFactor) {
      nodes.forEach(node => {
        node.y = node.depth * depthFactor;
      });
    }

    return { nodes, links };
  }

  /**
   * Set initial zoom and position.
   * Also limit zoom level according to `scaleExtent` on initial display. This is necessary,
   * because the first time we are setting it as an SVG property, instead of going
   * through D3's scaling mechanism, which would have picked up both properties.
   *
   * @static
   */
  static calculateD3Geometry(nextProps: TreeProps) {
    let scale;
    if (nextProps.zoom > nextProps.scaleExtent.max) {
      scale = nextProps.scaleExtent.max;
    } else if (nextProps.zoom < nextProps.scaleExtent.min) {
      scale = nextProps.scaleExtent.min;
    } else {
      scale = nextProps.zoom;
    }
    return {
      translate: nextProps.translate,
      scale,
    };
  }

  /**
   * Determines which additional `className` prop should be passed to the node & returns it.
   */
  getNodeClassName = (parent: HierarchyPointNode<TreeNodeDatum>, nodeDatum: TreeNodeDatum) => {
    const { rootNodeClassName, branchNodeClassName, leafNodeClassName } = this.props;
    const hasParent = parent !== null && parent !== undefined;
    if (hasParent) {
      return nodeDatum.children ? branchNodeClassName : leafNodeClassName;
    } else {
      return rootNodeClassName;
    }
  };

  render() {
    const { nodes, links } = this.generateTree();
    const {
      renderCustomNodeElement,
      orientation,
      pathFunc,
      transitionDuration,
      zoomable,
      nodeSize,
      depthFactor,
      initialDepth,
      separation,
      enableLegacyTransitions,
      svgClassName,
      pathClassFunc,
    } = this.props;
    const { translate, scale } = this.state.d3;
    const subscriptions = {
      ...nodeSize,
      ...separation,
      depthFactor,
      initialDepth,
    };

    return (
      <div className={`rd3t-tree-container ${zoomable ? 'rd3t-grabbable' : undefined}`}>
        <style>{globalCss}</style>
        <svg className={[rd3tSvgClassName, svgClassName].join(' ')} width="100%" height="100%">
          <TransitionGroupWrapper
            enableLegacyTransitions={enableLegacyTransitions}
            component="g"
            className={rd3tGClassName}
            transform={`translate(${translate.x},${translate.y}) scale(${scale})`}
          >
            {links.map((linkData, i) => {
              // console.log(linkData);
              return (
                <Link
                  key={'link-' + i}
                  orientation={orientation}
                  pathFunc={pathFunc}
                  pathClassFunc={pathClassFunc}
                  linkData={linkData}
                  onClick={this.handleOnLinkClickCb}
                  onMouseOver={this.handleOnLinkMouseOverCb}
                  onMouseOut={this.handleOnLinkMouseOutCb}
                  enableLegacyTransitions={enableLegacyTransitions}
                  transitionDuration={transitionDuration}
                />
              );
            })}

            {nodes.map(({ data, x, y, parent, ...rest }, i) => {
              // console.log({ data, x, y, parent, ...rest });
              return (
                <Node
                  key={'node-' + i}
                  data={data}
                  position={{ x, y }}
                  parent={parent}
                  nodeClassName={this.getNodeClassName(parent, data)}
                  renderCustomNodeElement={renderCustomNodeElement}
                  nodeSize={nodeSize}
                  orientation={orientation}
                  enableLegacyTransitions={enableLegacyTransitions}
                  transitionDuration={transitionDuration}
                  onNodeToggle={this.handleNodeToggle}
                  onNodeClick={this.handleOnNodeClickCb}
                  onNodeMouseOver={this.handleOnNodeMouseOverCb}
                  onNodeMouseOut={this.handleOnNodeMouseOutCb}
                  subscriptions={subscriptions}
                />
              );
            })}
          </TransitionGroupWrapper>
        </svg>
      </div>
    );
  }
}

export default Tree;
