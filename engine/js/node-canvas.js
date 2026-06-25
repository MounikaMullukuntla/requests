/**
 * Node Canvas — Flora-style typed-node creative flow.
 *
 * Nodes wired by typed ports (purple = text, orange = image):
 *   • Text node     — a prompt block.            output: text
 *   • Image node    — an uploaded source image.  output: image
 *   • Generate node — self-contained: pick any model from the dropdown and the
 *                     node adapts to it. Inputs: prompt (text) always, plus an
 *                     image input ONLY when the model supports image input.
 *                     Output type (image / text / video / 3d) follows the
 *                     model's capabilities; the output port is text or image
 *                     accordingly, so a Generate output can feed another node.
 *
 * Per-node model + key resolution reuses ArtsEngine.PROVIDER_MODELS /
 * PROVIDER_LABELS (sourced from chat/keys/providers.js, incl. the `imageInput`
 * and `outputs` flags) and the page's stored provider keys. Generation posts
 * to {apiBase}/generate/{image|text|video}; image input is forwarded as
 * image_urls and handled server-side per provider.
 */
(function () {
  "use strict";

  const RATIOS = [
    { key: "square", label: "Square · 1:1" },
    { key: "landscape-wide", label: "Wide · 16:9" },
    { key: "landscape", label: "Landscape · 4:3" },
    { key: "portrait-tall", label: "Tall · 9:16" },
    { key: "portrait", label: "Portrait · 3:4" },
  ];
  // Output kinds we can render, in preference order for a model's default.
  const OUTPUT_ORDER = ["image", "video", "3d", "text"];
  const STATE_DB = "arts-engine-node-canvas";
  const STATE_STORE = "workspace";
  const STATE_KEY = "current";

  let SEQ = 0;
  const getAE = () =>
    typeof artsEngine !== "undefined" && artsEngine ? artsEngine : null;
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class NodeCanvas {
    constructor(mount) {
      this.mount = mount;
      this.nodes = new Map();
      this.edges = []; // { from, to, toPort, ptype }
      this.nodeEls = new Map();
      this.pan = { x: 30, y: 24 };
      this.zoom = 1;
      this.selectedId = null;
      this._connecting = null;
      this._persistReady = false;
      this._saveTimer = null;
      this._dbPromise = null;
      this._build();
      this._bindPanelToggle();
      this._bindGlobal();
      this._restoreState().then((restored) => {
        if (!restored) this._seed();
        this._persistReady = true;
        this._saveState();
      }).catch((err) => {
        console.warn("Node Canvas restore failed:", err);
        this._seed();
        this._persistReady = true;
        this._saveState();
      });
      window.addEventListener("pagehide", () => this._saveState());
      (window.AE_CONFIG_PROMISE || Promise.resolve()).then(() => {
        const ae = getAE();
        if (ae && window.AE_API_BASE)
          ae.apiBase = window.AE_API_BASE.replace(/\/$/, "") + "/api";
        this.nodes.forEach((node) => {
          if (node.output3d) this._renderOutput(node);
        });
      });
    }

    _seed() {
      const t = this.addNode("text", { x: 30, y: 40 });
      const g = this.addNode("generate", { x: 320, y: 70 });
      this.addNode("image", { x: 30, y: 250 });
      this.connect(t.id, g.id, "prompt", "text");
    }

    _bindPanelToggle() {
      const panel = this.mount.closest("#nodeCanvasPanel");
      const toggle = panel?.querySelector("#nodeCanvasToggle");
      if (!panel || !toggle) return;
      const storageKey = "arts-engine-node-canvas-expanded";
      let expanded = false;
      try {
        expanded = window.localStorage.getItem(storageKey) === "true";
      } catch (_) {}

      const setExpanded = (isExpanded) => {
        panel.classList.toggle("nc-panel-collapsed", !isExpanded);
        toggle.setAttribute("aria-expanded", String(isExpanded));
        const icon = toggle.querySelector(".material-icons");
        const label = toggle.querySelector(".nc-panel-toggle-label");
        if (icon)
          icon.textContent = isExpanded ? "close_fullscreen" : "open_in_full";
        if (label) label.textContent = isExpanded ? "Minimize" : "Open Canvas";
      };

      setExpanded(expanded);
      toggle.addEventListener("click", () => {
        expanded = panel.classList.contains("nc-panel-collapsed");
        setExpanded(expanded);
        try {
          window.localStorage.setItem(storageKey, String(expanded));
        } catch (_) {}
        if (expanded) {
          requestAnimationFrame(() => {
            this._applyWorld();
            this._drawEdges();
          });
        }
      });
    }

    // ---- persistence ------------------------------------------------------
    _openStateDb() {
      if (this._dbPromise) return this._dbPromise;
      this._dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          reject(new Error("IndexedDB is unavailable"));
          return;
        }
        const req = window.indexedDB.open(STATE_DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STATE_STORE))
            req.result.createObjectStore(STATE_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this._dbPromise;
    }

    async _readSavedState() {
      try {
        const db = await this._openStateDb();
        return await new Promise((resolve, reject) => {
          const req = db
            .transaction(STATE_STORE, "readonly")
            .objectStore(STATE_STORE)
            .get(STATE_KEY);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
      } catch (err) {
        console.warn("Node Canvas state could not be loaded:", err);
        return null;
      }
    }

    _snapshot() {
      const nodes = [...this.nodes.values()].map((node) => ({
        id: node.id,
        type: node.type,
        x: node.x,
        y: node.y,
        text: node.text || "",
        uploadImage: node.uploadImage || null,
        outputImage: node.outputImage || null,
        outputText: node.outputText || null,
        output3d: node.output3d || null,
        output3dPoster: node.output3dPoster || null,
        provider: node.provider,
        model: node.model,
        outputType: node.outputType,
        ratio: node.ratio,
        instructions: node.instructions || "",
      }));
      return {
        version: 1,
        seq: SEQ,
        pan: this.pan,
        zoom: this.zoom,
        selectedId: this.selectedId,
        nodes,
        edges: this.edges.map((edge) => ({ ...edge })),
      };
    }

    async _saveState() {
      if (!this._persistReady) return;
      try {
        const db = await this._openStateDb();
        const state = this._snapshot();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STATE_STORE, "readwrite");
          tx.objectStore(STATE_STORE).put(state, STATE_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } catch (err) {
        console.warn("Node Canvas state could not be saved:", err);
      }
    }

    _scheduleSave() {
      if (!this._persistReady) return;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this._saveState(), 150);
    }

    async _restoreState() {
      const state = await this._readSavedState();
      if (!state || state.version !== 1 || !Array.isArray(state.nodes))
        return false;

      if (Number.isFinite(state.pan?.x) && Number.isFinite(state.pan?.y))
        this.pan = { x: state.pan.x, y: state.pan.y };
      if (Number.isFinite(state.zoom))
        this.zoom = Math.min(1.5, Math.max(0.1, state.zoom));

      for (const saved of state.nodes) {
        if (!saved?.id || !["text", "image", "generate"].includes(saved.type))
          continue;
        const node = {
          ...saved,
          x: Number.isFinite(saved.x) ? saved.x : 60,
          y: Number.isFinite(saved.y) ? saved.y : 60,
          generating: false,
          _error: null,
        };
        this.nodes.set(node.id, node);
        this._createNodeEl(node);
        this._positionNode(node);
        const numericId = Number.parseInt(node.id.replace(/^n/, ""), 10);
        if (Number.isFinite(numericId)) SEQ = Math.max(SEQ, numericId);
      }
      if (Number.isFinite(state.seq)) SEQ = Math.max(SEQ, state.seq);

      this.edges = (Array.isArray(state.edges) ? state.edges : []).filter(
        (edge) => this.nodes.has(edge.from) && this.nodes.has(edge.to),
      );
      this._applyWorld();
      this._refreshPorts();
      this._drawEdges();
      if (state.selectedId && this.nodes.has(state.selectedId))
        this.selectNode(state.selectedId);
      return true;
    }

    // ---- model registry helpers -----------------------------------------
    _allModels() {
      return (
        (typeof ArtsEngine !== "undefined" && ArtsEngine.PROVIDER_MODELS) || {
          env: [],
        }
      );
    }
    _modelsFor(provider) {
      return this._allModels()[provider] || [];
    }
    _modelCfg(provider, model) {
      const ms = this._modelsFor(provider);
      return ms.find((m) => m.value === model) || ms[0] || null;
    }
    _providerLabel(id) {
      const labels =
        (typeof ArtsEngine !== "undefined" && ArtsEngine.PROVIDER_LABELS) || {};
      return labels[id] || id;
    }
    _providersForMenu() {
      const all = this._allModels();
      const ae = getAE();
      let configured = new Set();
      // Read fresh from storage so it doesn't depend on app.js init timing.
      try {
        configured =
          ae?._readConfiguredProviders?.() ||
          ae?._configuredProviders ||
          new Set();
      } catch (_) {}
      const ids = Object.keys(all).filter(
        (id) => id === "env" || configured.has(id),
      );
      return ids.length
        ? ids
        : Object.keys(all).filter((p) => this._modelsFor(p).length);
    }
    _defaultModel() {
      const ae = getAE();
      const menu = this._providersForMenu();
      let provider = ae?.prefs?.provider;
      if (!menu.includes(provider)) provider = menu[0] || "env";
      const cfg = this._modelCfg(provider, ae?.prefs?.model);
      return {
        provider,
        model: cfg ? cfg.value : this._modelsFor(provider)[0]?.value || "",
      };
    }
    _renderableOutputs(cfg) {
      const outs = (cfg && cfg.outputs) || ["text"];
      return OUTPUT_ORDER.filter((o) => outs.includes(o));
    }
    _defaultOutputType(cfg) {
      return this._renderableOutputs(cfg)[0] || "text";
    }
    _modelSupportsImageInput(node) {
      return !!this._modelCfg(node.provider, node.model)?.imageInput;
    }
    _outPtype(node) {
      return node.outputType === "text" ? "text" : "image";
    }

    // ---- scaffold ---------------------------------------------------------
    _build() {
      this.mount.innerHTML = `
        <div class="nc-toolbar">
          <button class="nc-btn nc-btn-text"  data-add="text"><span class="material-icons">text_fields</span>Text</button>
          <button class="nc-btn nc-btn-image" data-add="image"><span class="material-icons">image</span>Image</button>
          <button class="nc-btn nc-btn-gen"   data-add="generate"><span class="material-icons">auto_awesome</span>Generate</button>
          <button class="nc-btn" data-act="reset"><span class="material-icons">center_focus_strong</span>Reset View</button>
          <button class="nc-btn" data-act="clear"><span class="material-icons">clear_all</span>Clear</button>
          <span class="nc-hint">Pick a model per Generate node · ports adapt to it · purple = text, orange = image</span>
        </div>
        <div class="nc-viewport">
          <div class="nc-world"><svg class="nc-edges"><g></g></svg></div>
          <div class="nc-zoom-controls" aria-label="Canvas zoom controls">
            <button type="button" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button>
            <span class="nc-zoom-level">100%</span>
            <button type="button" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button>
          </div>
          <div class="nc-minimap" title="Click to navigate the canvas">
            <canvas aria-label="Workflow minimap"></canvas>
          </div>
        </div>`;
      this.viewport = this.mount.querySelector(".nc-viewport");
      this.world = this.mount.querySelector(".nc-world");
      this.edgeLayer = this.mount.querySelector(".nc-edges g");
      this.zoomLevel = this.mount.querySelector(".nc-zoom-level");
      this.minimap = this.mount.querySelector(".nc-minimap");
      this.minimapCanvas = this.minimap.querySelector("canvas");

      this.mount.querySelector('[data-zoom="out"]').onclick = (e) => {
        e.stopPropagation();
        this._zoomBy(1 / 1.2);
      };
      this.mount.querySelector('[data-zoom="in"]').onclick = (e) => {
        e.stopPropagation();
        this._zoomBy(1.2);
      };
      this.minimap.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this._navigateFromMinimap(e);
      });

      this.mount.querySelectorAll("[data-add]").forEach((b) => {
        b.onclick = () => {
          const n = this.addNode(b.dataset.add, this._spawnPos());
          this.selectNode(n.id);
        };
      });
      this.mount.querySelector('[data-act="reset"]').onclick = () => {
        this._fitView();
        this._scheduleSave();
      };
      this.mount.querySelector('[data-act="clear"]').onclick = () => {
        if (!confirm("Remove all nodes from the canvas?")) return;
        this.nodes.clear();
        this.edges = [];
        this.nodeEls.clear();
        this.world.querySelectorAll(".nc-node").forEach((el) => el.remove());
        this._drawEdges();
        this.selectedId = null;
        clearTimeout(this._saveTimer);
        this._saveState();
      };
      this._applyWorld();
    }

    _spawnPos() {
      const arr = [...this.nodes.values()];
      const last = arr[arr.length - 1];
      return last ? { x: last.x + 36, y: last.y + 36 } : { x: 40, y: 40 };
    }

    _fitView() {
      if (!this.nodes.size) {
        this.pan = { x: 30, y: 24 };
        this.zoom = 1;
        this._applyWorld();
        this._drawEdges();
        return;
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      this.nodes.forEach((node, id) => {
        const el = this.nodeEls.get(id);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + (el?.offsetWidth || 220));
        maxY = Math.max(maxY, node.y + (el?.offsetHeight || 160));
      });

      const padding = 32;
      const viewportWidth = this.viewport.clientWidth;
      const viewportHeight = this.viewport.clientHeight;
      const contentWidth = Math.max(1, maxX - minX);
      const contentHeight = Math.max(1, maxY - minY);
      const availableWidth = Math.max(1, viewportWidth - padding * 2);
      const availableHeight = Math.max(1, viewportHeight - padding * 2);
      this.zoom = Math.min(
        1.5,
        Math.max(
          0.1,
          Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
        ),
      );
      this.pan = {
        x: (viewportWidth - contentWidth * this.zoom) / 2 - minX * this.zoom,
        y: (viewportHeight - contentHeight * this.zoom) / 2 - minY * this.zoom,
      };
      this._applyWorld();
      this._drawEdges();
    }

    _zoomBy(factor) {
      const cx = this.viewport.clientWidth / 2;
      const cy = this.viewport.clientHeight / 2;
      const worldX = (cx - this.pan.x) / this.zoom;
      const worldY = (cy - this.pan.y) / this.zoom;
      const next = Math.min(1.5, Math.max(0.1, this.zoom * factor));
      this.zoom = next;
      this.pan = {
        x: cx - worldX * next,
        y: cy - worldY * next,
      };
      this._applyWorld();
      this._drawEdges();
      this._scheduleSave();
    }

    _navigateFromMinimap(e) {
      const map = this._minimapTransform;
      if (!map) return;
      const rect = this.minimapCanvas.getBoundingClientRect();
      const worldX = (e.clientX - rect.left - map.offsetX) / map.scale + map.minX;
      const worldY = (e.clientY - rect.top - map.offsetY) / map.scale + map.minY;
      this.pan = {
        x: this.viewport.clientWidth / 2 - worldX * this.zoom,
        y: this.viewport.clientHeight / 2 - worldY * this.zoom,
      };
      this._applyWorld();
      this._drawEdges();
      this._scheduleSave();
    }

    _drawMinimap() {
      const canvas = this.minimapCanvas;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      if (!width || !height) return;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const view = {
        x: -this.pan.x / this.zoom,
        y: -this.pan.y / this.zoom,
        width: this.viewport.clientWidth / this.zoom,
        height: this.viewport.clientHeight / this.zoom,
      };
      let minX = view.x;
      let minY = view.y;
      let maxX = view.x + view.width;
      let maxY = view.y + view.height;
      this.nodes.forEach((node, id) => {
        const el = this.nodeEls.get(id);
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + (el?.offsetWidth || 220));
        maxY = Math.max(maxY, node.y + (el?.offsetHeight || 160));
      });

      const mapPadding = 7;
      const boundsWidth = Math.max(1, maxX - minX);
      const boundsHeight = Math.max(1, maxY - minY);
      const scale = Math.min(
        (width - mapPadding * 2) / boundsWidth,
        (height - mapPadding * 2) / boundsHeight,
      );
      const offsetX = (width - boundsWidth * scale) / 2;
      const offsetY = (height - boundsHeight * scale) / 2;
      this._minimapTransform = { minX, minY, scale, offsetX, offsetY };
      const px = (x) => offsetX + (x - minX) * scale;
      const py = (y) => offsetY + (y - minY) * scale;

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(100, 116, 139, 0.45)";
      for (const edge of this.edges) {
        const from = this.nodes.get(edge.from);
        const to = this.nodes.get(edge.to);
        if (!from || !to) continue;
        const fromEl = this.nodeEls.get(from.id);
        const toEl = this.nodeEls.get(to.id);
        ctx.beginPath();
        ctx.moveTo(
          px(from.x + (fromEl?.offsetWidth || 220) / 2),
          py(from.y + (fromEl?.offsetHeight || 160) / 2),
        );
        ctx.lineTo(
          px(to.x + (toEl?.offsetWidth || 220) / 2),
          py(to.y + (toEl?.offsetHeight || 160) / 2),
        );
        ctx.stroke();
      }

      const colors = {
        text: "#7c5cff",
        image: "#e2914a",
        generate: "#4a90e2",
      };
      this.nodes.forEach((node, id) => {
        const el = this.nodeEls.get(id);
        ctx.fillStyle = colors[node.type] || "#64748b";
        ctx.fillRect(
          px(node.x),
          py(node.y),
          Math.max(3, (el?.offsetWidth || 220) * scale),
          Math.max(3, (el?.offsetHeight || 160) * scale),
        );
      });

      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
      const vx = px(view.x);
      const vy = py(view.y);
      const vw = view.width * scale;
      const vh = view.height * scale;
      ctx.fillRect(vx, vy, vw, vh);
      ctx.strokeRect(vx, vy, vw, vh);
    }

    // ---- node data + DOM --------------------------------------------------
    addNode(type, opts = {}) {
      const id = "n" + ++SEQ;
      const node = {
        id,
        type,
        x: opts.x ?? 60,
        y: opts.y ?? 60,
        text: opts.text || "",
        uploadImage: null,
        outputImage: null,
        outputText: null,
        generating: false,
        _error: null,
      };
      if (type === "generate") {
        const def = this._defaultModel();
        const previous = [...this.nodes.values()]
          .reverse()
          .find((existing) => existing.type === "generate");
        node.provider = opts.provider || previous?.provider || def.provider;
        node.model = opts.model || previous?.model || def.model;
        const cfg = this._modelCfg(node.provider, node.model);
        const inheritedOutput = opts.outputType || previous?.outputType;
        node.outputType = this._renderableOutputs(cfg).includes(inheritedOutput)
          ? inheritedOutput
          : this._defaultOutputType(cfg);
        node.ratio =
          opts.ratio || previous?.ratio || getAE()?.prefs?.ratio || "square";
        node.instructions = opts.instructions || "";
      }
      this.nodes.set(id, node);
      this._createNodeEl(node);
      this._positionNode(node);
      this._drawMinimap();
      this._scheduleSave();
      return node;
    }

    _createNodeEl(node) {
      const el = document.createElement("div");
      el.className = `nc-node nc-type-${node.type}`;
      el.dataset.id = node.id;
      el.innerHTML = this._nodeMarkup(node);
      this.world.appendChild(el);
      this.nodeEls.set(node.id, el);
      if (node.output3d) {
        this._ensureModelViewer();
        this._wireModelViewer(el.querySelector(".nc-output"));
      }
      // Root-level listener bound once (survives body rebuilds).
      el.addEventListener("pointerdown", () => this.selectNode(node.id));
      this._wireNodeEl(node, el);
      if (node.type === "image") this._renderImageSlot(node);
      return el;
    }

    _nodeMarkup(node) {
      if (node.type === "text") {
        return `
          <div class="nc-node-head">
            <span class="material-icons">text_fields</span>
            <span class="nc-node-title">Text</span>
            <span class="nc-node-del material-icons" title="Delete node">close</span>
            <span class="nc-port nc-port-out" data-dir="out" data-ptype="text" title="Output"></span>
          </div>
          <div class="nc-node-body"><textarea placeholder="Describe the scene…">${esc(node.text)}</textarea></div>`;
      }
      if (node.type === "image") {
        return `
          <div class="nc-node-head">
            <span class="material-icons">image</span>
            <span class="nc-node-title">Image</span>
            <span class="nc-node-del material-icons" title="Delete node">close</span>
            <span class="nc-port nc-port-out" data-dir="out" data-ptype="image" title="Output"></span>
          </div>
          <div class="nc-node-body">
            <div class="nc-input-slot"><span class="nc-input-empty">+ click to upload an image</span>
              <input type="file" accept="image/*" hidden></div></div>`;
      }
      return this._generateMarkup(node);
    }

    _generateMarkup(node) {
      const cfg = this._modelCfg(node.provider, node.model);
      const renderable = this._renderableOutputs(cfg);
      const showRatio =
        node.outputType === "image" || node.outputType === "video";
      const outputCtrl =
        renderable.length > 1
          ? `<div class="nc-ratio-label">Output</div><select class="nc-output-type">${renderable
              .map(
                (o) =>
                  `<option value="${o}"${o === node.outputType ? " selected" : ""}>${o}</option>`,
              )
              .join("")}</select>`
          : `<div class="nc-out-kind">Output: ${esc(node.outputType)}</div>`;
      return `
        <div class="nc-node-head">
          <span class="material-icons">auto_awesome</span>
          <span class="nc-node-title">Generate</span>
          <span class="nc-node-del material-icons" title="Delete node">close</span>
          <span class="nc-port nc-port-out" data-dir="out" data-ptype="${this._outPtype(node)}" title="Output (${esc(node.outputType)})"></span>
        </div>
        <div class="nc-node-body">
          <select class="nc-model" title="Model for this node">${this._modelOptions(node.provider, node.model)}</select>
          <div class="nc-inrow" data-row="prompt">
            <span class="nc-port nc-port-in" data-dir="in" data-port="prompt" data-ptype="text" title="Prompt (from a Text node)"></span>
            Prompt
          </div>
          <div class="nc-inrow" data-row="image">${this._imageRowInner(node)}</div>
          <div class="nc-ratio-label">Instructions</div>
          <textarea class="nc-instr" placeholder="Extra instructions — style, lighting, constraints… (optional)">${esc(node.instructions || "")}</textarea>
          ${outputCtrl}
          ${
            showRatio
              ? `<div class="nc-ratio-label">Aspect ratio</div><select class="nc-ratio">${RATIOS.map(
                  (r) =>
                    `<option value="${r.key}"${r.key === node.ratio ? " selected" : ""}>${r.label}</option>`,
                ).join("")}</select>`
              : ""
          }
          <div class="nc-node-actions">
            <button class="nc-gen-btn"><span class="material-icons">auto_awesome</span>Generate</button>
            <button class="nc-next-btn" title="Add a follow-up scene fed by this output"><span class="material-icons">arrow_forward</span>Next</button>
          </div>
          <div class="nc-output">${this._outputInner(node)}</div>
        </div>`;
    }

    _modelOptions(selP, selM) {
      return this._providersForMenu()
        .map((p) => {
          const ms = this._modelsFor(p);
          if (!ms.length) return "";
          const opts = ms
            .map((m) => {
              const tags = [];
              const outs = (m.outputs || []).filter((o) => o !== "text");
              if (outs.length) tags.push(outs.join("/"));
              else tags.push("text");
              if (m.imageInput) tags.push("img-in");
              const sel = p === selP && m.value === selM ? " selected" : "";
              return `<option value="${esc(p + "::" + m.value)}"${sel}>${esc(m.label)}${tags.length ? " · " + esc(tags.join(", ")) : ""}</option>`;
            })
            .join("");
          return `<optgroup label="${esc(this._providerLabel(p))}">${opts}</optgroup>`;
        })
        .join("");
    }

    _imageRowInner(node) {
      if (this._modelSupportsImageInput(node)) {
        return `<span class="nc-port nc-port-in" data-dir="in" data-port="image" data-ptype="image" title="Image input (optional)"></span>Image input (optional)`;
      }
      return (
        `<span class="material-icons" style="font-size:0.9rem;color:#bbb;margin-right:2px">block</span>` +
        `<span style="color:#aab">No image input support</span>`
      );
    }

    _outputInner(node) {
      if (node.generating) {
        const elapsed = Math.max(
          0,
          Math.floor((Date.now() - (node._generationStartedAt || Date.now())) / 1000),
        );
        const label = node.outputType === "3d" ? "Generating 3D" : "Generating";
        return `<div class="nc-output-empty nc-generating"><span class="nc-spin"></span><span class="nc-elapsed">${label}… ${this._formatElapsed(elapsed)}</span></div>`;
      }
      if (node._error)
        return `<div class="nc-output-empty" style="color:#c33">${esc(node._error)}</div>`;
      if (node.outputType === "text" && node.outputText)
        return `<div class="nc-output-text">${esc(node.outputText)}</div>`;
      if (node.output3d) {
        const previewUrl = this._modelPreviewUrl(node.output3d);
        return `<div class="nc-model-output">
          <model-viewer src="${esc(previewUrl)}"${node.output3dPoster ? ` poster="${esc(node.output3dPoster)}"` : ""} camera-controls auto-rotate auto-rotate-delay="0" environment-image="neutral" exposure="1.25" shadow-intensity="0.8" tone-mapping="aces" loading="eager" interaction-prompt="none"></model-viewer>
          <div class="nc-model-status">Loading 3D preview…</div>
          <div class="nc-model-links">
            <a href="${esc(node.output3d)}" target="_blank" rel="noopener">Open 3D model</a>
            ${node.output3dPoster ? `<a href="${esc(node.output3dPoster)}" target="_blank" rel="noopener">Open rendered poster</a>` : ""}
          </div>
        </div>`;
      }
      if (node.outputImage) {
        return node.outputType === "video"
          ? `<video src="${node.outputImage}" controls></video>`
          : `<img src="${node.outputImage}" alt="output">`;
      }
      return `<div class="nc-output-empty">no output yet</div>`;
    }

    _formatElapsed(totalSeconds) {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    _modelPreviewUrl(url) {
      if (!/^https?:\/\//i.test(url)) return url;
      const apiBase = window.AE_API_BASE
        ? window.AE_API_BASE.replace(/\/$/, "") + "/api"
        : getAE()?.apiBase;
      return apiBase
        ? `${apiBase}/proxy/model?url=${encodeURIComponent(url)}`
        : url;
    }

    _ensureModelViewer() {
      if (window.customElements?.get("model-viewer")) return;
      if (document.querySelector("script[data-nc-model-viewer]")) return;
      const script = document.createElement("script");
      script.type = "module";
      script.src = "https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js";
      script.dataset.ncModelViewer = "1";
      script.onerror = () => {
        this._modelViewerFailed = true;
        this.mount.querySelectorAll(".nc-model-status").forEach((status) => {
          status.hidden = false;
          status.textContent =
            "3D viewer failed to load. Use Open 3D model below.";
          status.classList.add("error");
        });
      };
      document.head.appendChild(script);
    }

    _wireModelViewer(root) {
      const viewer = root?.querySelector("model-viewer");
      const status = root?.querySelector(".nc-model-status");
      if (!viewer || !status || viewer.dataset.ncWired) return;
      viewer.dataset.ncWired = "1";
      if (this._modelViewerFailed) {
        status.textContent =
          "3D viewer failed to load. Use Open 3D model below.";
        status.classList.add("error");
      }
      const timeout = setTimeout(() => {
        if (status.hidden) return;
        status.textContent =
          "3D preview is taking too long. Use Open 3D model below.";
        status.classList.add("error");
      }, 30000);
      viewer.addEventListener("load", () => {
        clearTimeout(timeout);
        status.hidden = true;
        this._drawMinimap();
      });
      viewer.addEventListener("error", () => {
        clearTimeout(timeout);
        status.hidden = false;
        status.textContent =
          "3D preview unavailable. Use Open 3D model below.";
        status.classList.add("error");
      });
    }

    _wireNodeEl(node, el) {
      el.querySelector(".nc-node-head").addEventListener("pointerdown", (e) =>
        this._startNodeDrag(e, node),
      );
      el.querySelector(".nc-node-del").addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.removeNode(node.id);
      });
      el.querySelectorAll(".nc-port-out").forEach((p) =>
        p.addEventListener("pointerdown", (e) =>
          this._startConnect(e, node.id, p.dataset.ptype),
        ),
      );

      if (node.type === "text") {
        const ta = el.querySelector("textarea");
        ta.addEventListener("input", () => {
          node.text = ta.value;
          this._scheduleSave();
        });
        ta.addEventListener("pointerdown", (e) => e.stopPropagation());
      } else if (node.type === "image") {
        const slot = el.querySelector(".nc-input-slot");
        slot.addEventListener("click", (e) => {
          e.stopPropagation();
          slot.querySelector("input[type=file]").click();
        });
        el.querySelector("input[type=file]").addEventListener("change", (ev) =>
          this._onUpload(node, ev.target),
        );
      } else {
        const stop = (e) => e.stopPropagation();
        const model = el.querySelector(".nc-model");
        model.addEventListener("change", (e) =>
          this._onModelPick(node, e.target.value),
        );
        model.addEventListener("pointerdown", stop);
        const ot = el.querySelector(".nc-output-type");
        if (ot) {
          ot.addEventListener("change", (e) => {
            node.outputType = e.target.value;
            this._rebuildGenerate(node);
          });
          ot.addEventListener("pointerdown", stop);
        }
        const rt = el.querySelector(".nc-ratio");
        if (rt) {
          rt.addEventListener("change", (e) => {
            node.ratio = e.target.value;
            this._scheduleSave();
          });
          rt.addEventListener("pointerdown", stop);
        }
        const instr = el.querySelector(".nc-instr");
        if (instr) {
          instr.addEventListener("input", (e) => {
            node.instructions = e.target.value;
            this._scheduleSave();
          });
          instr.addEventListener("pointerdown", stop);
        }
        el.querySelector(".nc-gen-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          this.generateNode(node.id);
        });
        el.querySelector(".nc-next-btn").addEventListener("click", (e) => {
          e.stopPropagation();
          this.nextScene(node.id);
        });
      }
    }

    _onModelPick(node, val) {
      const [provider, model] = val.split("::");
      node.provider = provider;
      node.model = model;
      const cfg = this._modelCfg(provider, model);
      if (!this._renderableOutputs(cfg).includes(node.outputType))
        node.outputType = this._defaultOutputType(cfg);
      this._rebuildGenerate(node);
    }

    // Rebuild a Generate node in place when its model/output changes; prune
    // connections the new shape can't support.
    _rebuildGenerate(node) {
      const cfg = this._modelCfg(node.provider, node.model);
      if (!this._modelSupportsImageInput(node))
        this.edges = this.edges.filter(
          (e) => !(e.to === node.id && e.toPort === "image"),
        );
      const outP = this._outPtype(node);
      this.edges = this.edges.filter(
        (e) => e.from !== node.id || e.ptype === outP,
      );
      const el = this.nodeEls.get(node.id);
      el.innerHTML = this._nodeMarkup(node);
      this._wireNodeEl(node, el);
      this._refreshPorts();
      this._drawEdges();
      this._scheduleSave();
    }

    _onUpload(node, input) {
      const f = input.files && input.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        node.uploadImage = r.result;
        this._renderImageSlot(node);
        this._scheduleSave();
      };
      r.readAsDataURL(f);
    }

    _renderImageSlot(node) {
      const el = this.nodeEls.get(node.id);
      const slot = el && el.querySelector(".nc-input-slot");
      if (!slot) return;
      if (node.uploadImage) {
        slot.classList.add("nc-has-img");
        slot.innerHTML = `<img src="${node.uploadImage}" alt="input"><input type="file" accept="image/*" hidden>`;
      } else {
        slot.classList.remove("nc-has-img");
        slot.innerHTML = `<span class="nc-input-empty">+ click to upload an image</span><input type="file" accept="image/*" hidden>`;
      }
      slot
        .querySelector("input[type=file]")
        .addEventListener("change", (ev) => this._onUpload(node, ev.target));
    }

    removeNode(id) {
      const node = this.nodes.get(id);
      if (node?._elapsedTimer) clearInterval(node._elapsedTimer);
      this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
      this.nodeEls.get(id)?.remove();
      this.nodeEls.delete(id);
      this.nodes.delete(id);
      // Drop its Storyboard scene, if it had one.
      const ae = getAE();
      if (node && ae && Array.isArray(ae.scenes)) {
        const scene = node._scene || ae.scenes.find((item) =>
          item?._nodeCanvasId === node.id ||
          (node.outputImage && item?.image === node.outputImage),
        );
        const i = scene ? ae.scenes.indexOf(scene) : -1;
        if (i >= 0) ae.scenes.splice(i, 1);
        if (typeof ae.renderStoryboard === "function") ae.renderStoryboard();
      }
      this._refreshPorts();
      this._drawEdges();
      this._scheduleSave();
    }

    selectNode(id) {
      this.selectedId = id;
      this.nodeEls.forEach((el, nid) =>
        el.classList.toggle("nc-selected", nid === id),
      );
      this._scheduleSave();
    }

    // ---- "Next scene" -----------------------------------------------------
    nextScene(fromGenId) {
      const g = this.nodes.get(fromGenId);
      if (!g) return;
      const text = this.addNode("text", { x: g.x + 320, y: g.y - 150 });
      // Instructions are per-node only — a new scene starts with a blank field.
      const gen = this.addNode("generate", {
        x: g.x + 320,
        y: g.y + 30,
        provider: g.provider,
        model: g.model,
        outputType: g.outputType,
        ratio: g.ratio,
      });
      // Feed previous output as image input only when both ends make sense.
      if (
        this._modelSupportsImageInput(gen) &&
        g.outputType !== "text" &&
        g.outputType !== "video"
      ) {
        this.connect(fromGenId, gen.id, "image", "image");
      }
      this.connect(text.id, gen.id, "prompt", "text");
      this.selectNode(text.id);
      this.nodeEls.get(text.id).querySelector("textarea").focus();
      this._drawEdges();
    }

    // ---- connections ------------------------------------------------------
    connect(fromId, toId, toPort, ptype) {
      if (fromId === toId || this._wouldCycle(fromId, toId)) return;
      this.edges = this.edges.filter(
        (e) => !(e.to === toId && e.toPort === toPort),
      );
      this.edges.push({ from: fromId, to: toId, toPort, ptype });
      this._refreshPorts();
      this._drawEdges();
      this._scheduleSave();
    }

    _wouldCycle(fromId, toId) {
      const seen = new Set();
      const stack = [toId];
      while (stack.length) {
        const cur = stack.pop();
        if (cur === fromId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        this.edges
          .filter((e) => e.from === cur)
          .forEach((e) => stack.push(e.to));
      }
      return false;
    }

    _refreshPorts() {
      this.nodeEls.forEach((el, id) => {
        el.querySelectorAll(".nc-port-in").forEach((p) => {
          const filled = this.edges.some(
            (e) => e.to === id && e.toPort === p.dataset.port,
          );
          p.classList.toggle("nc-filled", filled);
        });
      });
    }

    _startConnect(e, fromId, ptype) {
      e.stopPropagation();
      e.preventDefault();
      this._connecting = { fromId, ptype };
      const move = (ev) =>
        this._drawEdges(this._toWorld(ev.clientX, ev.clientY));
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const port = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest(".nc-port-in");
        if (port && port.dataset.ptype === ptype) {
          const toEl = port.closest(".nc-node");
          if (toEl)
            this.connect(fromId, toEl.dataset.id, port.dataset.port, ptype);
        }
        this._connecting = null;
        this._drawEdges();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    // ---- resolve inputs ---------------------------------------------------
    getPrompt(genNode) {
      const e = this.edges.find(
        (x) => x.to === genNode.id && x.toPort === "prompt",
      );
      const src = e && this.nodes.get(e.from);
      if (!src) return "";
      if (src.type === "text") return (src.text || "").trim();
      if (src.type === "generate" && src.outputType === "text")
        return (src.outputText || "").trim();
      return "";
    }

    // Full prompt sent to the model: the scene text (from the Text node) plus
    // this node's own extra instructions (style etc.). getPrompt() stays the
    // scene-only text so the Storyboard shows the scene, not the styling.
    _finalPrompt(node) {
      const scene = this.getPrompt(node);
      const extra = (node.instructions || "").trim();
      return [scene, extra].filter(Boolean).join("\n\n");
    }

    _fillTemplate(value, substitutions) {
      if (typeof value === "string") {
        return value.replace(/\{(\w+)\}/g, (match, key) =>
          key in substitutions ? substitutions[key] : match,
        );
      }
      if (Array.isArray(value))
        return value.map((item) => this._fillTemplate(item, substitutions));
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            this._fillTemplate(item, substitutions),
          ]),
        );
      }
      return value;
    }

    async _prepareTripoImage(image, apiBase, headers) {
      if (/^https?:\/\//i.test(image)) {
        const pathname = new URL(image).pathname.toLowerCase();
        return {
          type: pathname.endsWith(".png") ? "png" : "jpg",
          url: image,
        };
      }
      const response = await fetch(`${apiBase}/upload/tripo`, {
        method: "POST",
        headers,
        body: JSON.stringify({ image }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `Tripo upload HTTP ${response.status}`);
      }
      const data = await response.json();
      return {
        type: data.file_type || "jpg",
        file_token: data.file_token,
      };
    }

    getImageInput(genNode) {
      const e = this.edges.find(
        (x) => x.to === genNode.id && x.toPort === "image",
      );
      const src = e && this.nodes.get(e.from);
      if (!src) return null;
      if (src.type === "image") return src.uploadImage || null;
      if (
        src.type === "generate" &&
        src.outputType !== "text" &&
        src.outputType !== "video"
      ) {
        if (src.outputType === "3d") return src.output3dPoster || null;
        return src.outputImage || null;
      }
      return null;
    }

    // ---- node drag + canvas pan/zoom -------------------------------------
    _startNodeDrag(e, node) {
      if (e.target.closest(".nc-port") || e.target.closest(".nc-node-del"))
        return;
      e.stopPropagation();
      e.preventDefault();
      this.selectNode(node.id);
      const start = this._toWorld(e.clientX, e.clientY);
      const ox = start.x - node.x,
        oy = start.y - node.y;
      const move = (ev) => {
        const p = this._toWorld(ev.clientX, ev.clientY);
        node.x = p.x - ox;
        node.y = p.y - oy;
        this._positionNode(node);
        this._drawEdges();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        this._scheduleSave();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    _bindGlobal() {
      this.viewport.addEventListener("pointerdown", (e) => {
        if (
          e.target !== this.viewport &&
          e.target !== this.world &&
          !e.target.closest("svg")
        )
          return;
        const startPan = {
          sx: e.clientX,
          sy: e.clientY,
          px: this.pan.x,
          py: this.pan.y,
        };
        this.viewport.classList.add("nc-panning");
        const move = (ev) => {
          this.pan.x = startPan.px + (ev.clientX - startPan.sx);
          this.pan.y = startPan.py + (ev.clientY - startPan.sy);
          this._applyWorld();
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          this.viewport.classList.remove("nc-panning");
          this._scheduleSave();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });

      this.viewport.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = this.viewport.getBoundingClientRect();
          const cx = e.clientX - rect.left,
            cy = e.clientY - rect.top;
          const old = this.zoom;
          const next = Math.min(
            1.5,
            Math.max(0.1, old * (e.deltaY < 0 ? 1.1 : 0.9)),
          );
          this.pan.x = cx - (cx - this.pan.x) * (next / old);
          this.pan.y = cy - (cy - this.pan.y) * (next / old);
          this.zoom = next;
          this._applyWorld();
          this._drawEdges();
          this._scheduleSave();
        },
        { passive: false },
      );
    }

    _applyWorld() {
      this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
      if (this.zoomLevel)
        this.zoomLevel.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    _toWorld(clientX, clientY) {
      const rect = this.viewport.getBoundingClientRect();
      return {
        x: (clientX - rect.left - this.pan.x) / this.zoom,
        y: (clientY - rect.top - this.pan.y) / this.zoom,
      };
    }

    _positionNode(node) {
      const el = this.nodeEls.get(node.id);
      if (el) {
        el.style.left = node.x + "px";
        el.style.top = node.y + "px";
      }
    }

    _portCenter(nodeId, selector) {
      const el = this.nodeEls.get(nodeId);
      const port = el && el.querySelector(selector);
      if (!port) return null;
      const r = port.getBoundingClientRect();
      return this._toWorld(r.left + r.width / 2, r.top + r.height / 2);
    }

    _drawEdges(tempTo) {
      while (this.edgeLayer.firstChild)
        this.edgeLayer.removeChild(this.edgeLayer.firstChild);
      for (const e of this.edges) {
        const p1 = this._portCenter(e.from, ".nc-port-out");
        const p2 = this._portCenter(
          e.to,
          `.nc-port-in[data-port="${e.toPort}"]`,
        );
        if (p1 && p2) this._addPath(p1, p2, e.ptype, false);
      }
      if (this._connecting && tempTo) {
        const p1 = this._portCenter(this._connecting.fromId, ".nc-port-out");
        if (p1) this._addPath(p1, tempTo, this._connecting.ptype, true);
      }
      this._drawMinimap();
    }

    _addPath(p1, p2, ptype, temp) {
      const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.5);
      const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", d);
      path.setAttribute(
        "class",
        `nc-edge-${ptype}${temp ? " nc-edge-temp" : ""}`,
      );
      this.edgeLayer.appendChild(path);
    }

    // ---- generation -------------------------------------------------------
    _providerHeaders(node) {
      if (!node.provider || node.provider === "env") return {};
      const key = window.KeyManager?.get(node.provider);
      return key
        ? { "X-Provider-Name": node.provider, "X-Provider-Key": key }
        : {};
    }

    // Mirror a Generate node's image output into the page's shared `scenes`
    // array so it shows in the Storyboard Flow as that node's scene. Each
    // node keeps a stable reference to its own scene object.
    _syncToStoryboard(node) {
      const ae = getAE();
      if (
        !ae ||
        !Array.isArray(ae.scenes) ||
        typeof ae.renderStoryboard !== "function"
      )
        return;
      if (!node._scene || ae.scenes.indexOf(node._scene) < 0) {
        node._scene = ae.scenes.find((scene) =>
          scene?._nodeCanvasId === node.id ||
          (node.outputImage && scene?.image === node.outputImage),
        );
      }
      if (!node._scene) {
        node._scene = {
          scene: String(ae.scenes.length + 1),
          _nodeCanvasId: node.id,
          prompt: "",
          aspect_ratio: "",
          style: "",
          image: null,
          text: null,
        };
        ae.scenes.push(node._scene);
      }
      node._scene._nodeCanvasId = node.id;
      node._scene.prompt = this.getPrompt(node) || node._scene.prompt || "";
      node._scene.image = node.outputImage;
      ae.renderStoryboard();
    }

    _renderOutput(node) {
      const out = this.nodeEls.get(node.id)?.querySelector(".nc-output");
      if (!out) return;
      out.innerHTML = this._outputInner(node);
      this._drawMinimap();
      this._wireModelViewer(out);
      const media = out.querySelector("img");
      if (media)
        media.addEventListener("click", () => {
          const ae = getAE();
          if (ae?.openLightbox) ae.openLightbox(node.outputImage);
          else window.open(node.outputImage, "_blank");
        });
    }

    async generateNode(id) {
      const node = this.nodes.get(id);
      if (!node || node.generating) return;
      const ae = getAE();
      const el = this.nodeEls.get(id);
      const btn = el.querySelector(".nc-gen-btn");

      const prompt = this._finalPrompt(node);
      node._error = null;
      // Clear any prior 3D model so it can't mask a new image/video/text output
      // (_outputInner checks output3d before outputImage).
      node.output3d = null;
      node.output3dPoster = null;
      // Image-to-3D can run from just a connected image (no text prompt needed).
      const has3dImage =
        node.outputType === "3d" &&
        this._modelSupportsImageInput(node) &&
        !!this.getImageInput(node);
      if (!prompt && !has3dImage) {
        node._error = "Connect a Text node, or add instructions";
        this._renderOutput(node);
        return;
      }
      if (!ae) {
        node._error = "Engine not ready";
        this._renderOutput(node);
        return;
      }

      if (window.KeyManager?.initCrypto)
        await window.KeyManager.initCrypto().catch(() => {});
      if (window.AE_API_BASE)
        ae.apiBase = window.AE_API_BASE.replace(/\/$/, "") + "/api";
      const apiBase = ae.apiBase;
      const headers = {
        "Content-Type": "application/json",
        ...this._providerHeaders(node),
      };

      node.generating = true;
      node._generationStartedAt = Date.now();
      if (node.outputType === "3d") {
        node._elapsedTimer = setInterval(() => {
          if (!node.generating) return;
          const elapsed = Math.floor(
            (Date.now() - node._generationStartedAt) / 1000,
          );
          const label = this.nodeEls
            .get(node.id)
            ?.querySelector(".nc-elapsed");
          if (label)
            label.textContent = `Generating 3D… ${this._formatElapsed(elapsed)}`;
        }, 1000);
      }
      btn.disabled = true;
      this._renderOutput(node);

      try {
        if (node.outputType === "text") {
          const resp = await fetch(`${apiBase}/generate/text`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt, model: node.model }),
          });
          if (!resp.ok) {
            const er = await resp.json().catch(() => ({}));
            throw new Error(er.error || `HTTP ${resp.status}`);
          }
          const data = await resp.json();
          node.outputText = data.text || "(no text returned)";
          node.outputImage = null;
        } else if (node.outputType === "video") {
          const resp = await fetch(`${apiBase}/generate/video`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              prompt,
              model: node.model,
              aspect_ratio: ae.ratioToApiString(node.ratio),
            }),
          });
          if (!resp.ok) {
            const er = await resp.json().catch(() => ({}));
            throw new Error(er.error || `HTTP ${resp.status}`);
          }
          const data = await resp.json();
          let url = data.media_urls?.[0];
          if (!url) {
            const jobId = data.id || data.raw?.request_id;
            if (!jobId)
              throw new Error("Video submitted but no job id returned");
            url = await this._pollVideo(apiBase, jobId);
          }
          node.outputImage = url;
        } else if (node.outputType === "3d") {
          const inputImg = this._modelSupportsImageInput(node)
            ? this.getImageInput(node)
            : null;
          const modelCfg = this._modelCfg(node.provider, node.model);
          const providerCfg = (window.KeyManagerProviders || []).find(
            (provider) => provider.id === node.provider,
          );
          const spec = providerCfg?.task3d;
          if (!spec)
            throw new Error(
              `No 3D configuration found for provider "${node.provider}"`,
            );
          const useTripoImage = node.provider === "tripo" && !!inputImg;
          const mode = useTripoImage
            ? "image_to_model"
            : modelCfg?.apiMode || modelCfg?.value;
          let modeSpec = spec.modes?.[mode];
          if (useTripoImage) {
            const file = await this._prepareTripoImage(
              inputImg,
              apiBase,
              headers,
            );
            modeSpec = {
              submitPath: "/task",
              body: {
                type: "image_to_model",
                model_version: "{model}",
                file,
                texture: true,
                pbr: true,
              },
            };
          }
          if (!modeSpec)
            throw new Error(
              `3D mode "${mode}" is not configured for "${node.provider}"`,
            );
          const substitutions = {
            prompt,
            model: modelCfg?.apiModel || modelCfg?.value || "",
            image_url: inputImg || "",
          };
          const body = {
            provider: node.provider,
            model: modelCfg?.value || "",
            submit_url:
              String(spec.base || "").replace(/\/$/, "") +
              (modeSpec.submitPath || ""),
            submit_body: this._fillTemplate(modeSpec.body, substitutions),
            task_id_path: spec.taskIdPath,
            status_value_path: spec.statusValuePath,
            status_success: spec.statusSuccess,
            status_failure: spec.statusFailure,
            error_message_path: spec.errorMessagePath ?? null,
            output_path: spec.outputPath,
            output_keys: spec.outputKeys,
            error_code_path: spec.errorCodePath ?? null,
            no_credits_code: spec.noCreditsCode ?? null,
          };
          const resp = await fetch(`${apiBase}/generate/3d`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const er = await resp.json().catch(() => ({}));
            throw new Error(er.error || `HTTP ${resp.status}`);
          }
          const data = await resp.json();
          const urls = data.media_urls || [];
          node.output3d =
            urls.find((u) => /\.glb(\?|$)/i.test(u)) || urls[0] || null;
          node.output3dPoster =
            urls.find((u) => /\.(webp|jpe?g|png)(\?|$)/i.test(u)) || null;
          node.outputImage = null;
          node.outputText = null;
          if (!node.output3d) throw new Error("No 3D model returned");
          this._ensureModelViewer();
        } else {
          const body = {
            prompt,
            model: node.model,
            aspect_ratio: ae.ratioToApiString(node.ratio),
            response_format:
              node.provider === "pollinations" ? "b64_json" : "url",
          };
          const inputImg = this._modelSupportsImageInput(node)
            ? this.getImageInput(node)
            : null;
          if (inputImg) body.image_urls = [inputImg];
          const resp = await fetch(`${apiBase}/generate/image`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const er = await resp.json().catch(() => ({}));
            throw new Error(er.error || `HTTP ${resp.status}`);
          }
          const data = await resp.json();
          const url = data.media_urls?.[0] || data.images?.[0]?.url || null;
          if (!url) throw new Error("No image returned");
          node.outputImage = url;
          node.outputText = null;
          this._syncToStoryboard(node);
        }
      } catch (err) {
        node._error = err.message || "Error";
      } finally {
        if (node._elapsedTimer) {
          clearInterval(node._elapsedTimer);
          node._elapsedTimer = null;
        }
        node.generating = false;
        btn.disabled = false;
        this._renderOutput(node);
        this._scheduleSave();
      }
    }

    async _pollVideo(apiBase, id) {
      for (let i = 0; i < 120; i++) {
        // up to ~10 min at 5s
        await sleep(5000);
        const resp = await fetch(`${apiBase}/generate/video/${id}`);
        if (!resp.ok) continue;
        const d = await resp.json();
        if (d.status === "failed") throw new Error("Video generation failed");
        if (d.media_urls?.length) return d.media_urls[0];
      }
      throw new Error("Video generation timed out");
    }

    async _poll3d(apiBase, id, headers) {
      // Tripo is per-request-key only, so the poll must resend the provider headers.
      for (let i = 0; i < 120; i++) {
        // up to ~10 min at 5s
        await sleep(5000);
        const resp = await fetch(`${apiBase}/generate/3d/${id}`, { headers });
        if (!resp.ok) continue;
        const d = await resp.json();
        if (d.status === "failed")
          throw new Error(
            "3D generation failed: " + (d.text || "unknown error"),
          );
        if (d.media_urls?.length) return d.media_urls;
      }
      throw new Error("3D generation timed out");
    }
  }

  function mount() {
    const el = document.getElementById("nodeCanvasMount");
    if (!el || el.dataset.mounted) return;
    el.dataset.mounted = "1";
    window.nodeCanvas = new NodeCanvas(el);
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
