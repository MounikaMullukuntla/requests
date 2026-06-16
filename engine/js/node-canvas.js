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
      this._build();
      this._bindGlobal();
      this._seed();
    }

    _seed() {
      const t = this.addNode("text", { x: 30, y: 40 });
      const g = this.addNode("generate", { x: 320, y: 70 });
      this.addNode("image", { x: 30, y: 250 });
      this.connect(t.id, g.id, "prompt", "text");
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
        <div class="nc-viewport"><div class="nc-world"><svg class="nc-edges"><g></g></svg></div></div>`;
      this.viewport = this.mount.querySelector(".nc-viewport");
      this.world = this.mount.querySelector(".nc-world");
      this.edgeLayer = this.mount.querySelector(".nc-edges g");

      this.mount.querySelectorAll("[data-add]").forEach((b) => {
        b.onclick = () => {
          const n = this.addNode(b.dataset.add, this._spawnPos());
          this.selectNode(n.id);
        };
      });
      this.mount.querySelector('[data-act="reset"]').onclick = () => {
        this.pan = { x: 30, y: 24 };
        this.zoom = 1;
        this._applyWorld();
        this._drawEdges();
      };
      this.mount.querySelector('[data-act="clear"]').onclick = () => {
        if (!confirm("Remove all nodes from the canvas?")) return;
        this.nodes.clear();
        this.edges = [];
        this.nodeEls.clear();
        this.world.querySelectorAll(".nc-node").forEach((el) => el.remove());
        this._drawEdges();
      };
      this._applyWorld();
    }

    _spawnPos() {
      const arr = [...this.nodes.values()];
      const last = arr[arr.length - 1];
      return last ? { x: last.x + 36, y: last.y + 36 } : { x: 40, y: 40 };
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
        node.provider = opts.provider || def.provider;
        node.model = opts.model || def.model;
        const cfg = this._modelCfg(node.provider, node.model);
        node.outputType =
          opts.outputType &&
          this._renderableOutputs(cfg).includes(opts.outputType)
            ? opts.outputType
            : this._defaultOutputType(cfg);
        node.ratio = opts.ratio || getAE()?.prefs?.ratio || "square";
        node.instructions = opts.instructions || "";
      }
      this.nodes.set(id, node);
      this._createNodeEl(node);
      this._positionNode(node);
      return node;
    }

    _createNodeEl(node) {
      const el = document.createElement("div");
      el.className = `nc-node nc-type-${node.type}`;
      el.dataset.id = node.id;
      el.innerHTML = this._nodeMarkup(node);
      this.world.appendChild(el);
      this.nodeEls.set(node.id, el);
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
      if (node.generating)
        return `<div class="nc-output-empty"><span class="nc-spin"></span></div>`;
      if (node._error)
        return `<div class="nc-output-empty" style="color:#c33">${esc(node._error)}</div>`;
      if (node.outputType === "text" && node.outputText)
        return `<div class="nc-output-text">${esc(node.outputText)}</div>`;
      if (node.output3d) {
        return `<model-viewer src="${esc(node.output3d)}"${node.output3dPoster ? ` poster="${esc(node.output3dPoster)}"` : ""} camera-controls auto-rotate environment-image="neutral" exposure="1" shadow-intensity="1" tone-mapping="aces" loading="eager" style="width:100%;height:100%;background:#1a1a1a;--poster-color:transparent"></model-viewer>`;
      }
      if (node.outputImage) {
        return node.outputType === "video"
          ? `<video src="${node.outputImage}" controls></video>`
          : `<img src="${node.outputImage}" alt="output">`;
      }
      return `<div class="nc-output-empty">no output yet</div>`;
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
          });
          rt.addEventListener("pointerdown", stop);
        }
        const instr = el.querySelector(".nc-instr");
        if (instr) {
          instr.addEventListener("input", (e) => {
            node.instructions = e.target.value;
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
      if (!cfg?.imageInput)
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
    }

    _onUpload(node, input) {
      const f = input.files && input.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        node.uploadImage = r.result;
        this._renderImageSlot(node);
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
      this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
      this.nodeEls.get(id)?.remove();
      this.nodeEls.delete(id);
      this.nodes.delete(id);
      // Drop its Storyboard scene, if it had one.
      const ae = getAE();
      if (node?._scene && ae && Array.isArray(ae.scenes)) {
        const i = ae.scenes.indexOf(node._scene);
        if (i >= 0) ae.scenes.splice(i, 1);
        if (typeof ae.renderStoryboard === "function") ae.renderStoryboard();
      }
      this._refreshPorts();
      this._drawEdges();
    }

    selectNode(id) {
      this.selectedId = id;
      this.nodeEls.forEach((el, nid) =>
        el.classList.toggle("nc-selected", nid === id),
      );
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
      )
        return src.outputImage || null;
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
            Math.max(0.4, old * (e.deltaY < 0 ? 1.1 : 0.9)),
          );
          this.pan.x = cx - (cx - this.pan.x) * (next / old);
          this.pan.y = cy - (cy - this.pan.y) * (next / old);
          this.zoom = next;
          this._applyWorld();
          this._drawEdges();
        },
        { passive: false },
      );
    }

    _applyWorld() {
      this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
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
        node._scene = {
          scene: String(ae.scenes.length + 1),
          prompt: "",
          aspect_ratio: "",
          style: "",
          image: null,
          text: null,
        };
        ae.scenes.push(node._scene);
      }
      node._scene.prompt = this.getPrompt(node) || node._scene.prompt || "";
      node._scene.image = node.outputImage;
      ae.renderStoryboard();
    }

    _renderOutput(node) {
      const out = this.nodeEls.get(node.id)?.querySelector(".nc-output");
      if (!out) return;
      out.innerHTML = this._outputInner(node);
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
          // Image-to-3D when a reference image is connected (Tripo supports it),
          // otherwise text-to-3D. The backend accepts data: or http(s) URLs.
          const inputImg = this._modelSupportsImageInput(node)
            ? this.getImageInput(node)
            : null;
          const body = { prompt, model: node.model };
          if (inputImg) body.image_urls = [inputImg];
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
          let urls = data.media_urls || [];
          if (!urls.length) {
            const jobId = data.id;
            if (!jobId) throw new Error("3D submitted but no job id returned");
            urls = await this._poll3d(apiBase, jobId, headers);
          }
          node.output3d =
            urls.find((u) => /\.glb(\?|$)/i.test(u)) || urls[0] || null;
          node.output3dPoster =
            urls.find((u) => /\.(webp|jpe?g|png)(\?|$)/i.test(u)) || null;
          node.outputImage = null;
          node.outputText = null;
          if (!node.output3d) throw new Error("No 3D model returned");
          getAE()?._ensureModelViewer?.();
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
        node.generating = false;
        btn.disabled = false;
        this._renderOutput(node);
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
