function t(t,e,i,n){var s,o=arguments.length,r=o<3?e:null===n?n=Object.getOwnPropertyDescriptor(e,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(t,e,i,n);else for(var a=t.length-1;a>=0;a--)(s=t[a])&&(r=(o<3?s(r):o>3?s(e,i,r):s(e,i))||r);return o>3&&r&&Object.defineProperty(e,i,r),r}"function"==typeof SuppressedError&&SuppressedError;const e=globalThis,i=e.ShadowRoot&&(void 0===e.ShadyCSS||e.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,n=Symbol(),s=new WeakMap;let o=class{constructor(t,e,i){if(this._$cssResult$=!0,i!==n)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=e}get styleSheet(){let t=this.o;const e=this.t;if(i&&void 0===t){const i=void 0!==e&&1===e.length;i&&(t=s.get(e)),void 0===t&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),i&&s.set(e,t))}return t}toString(){return this.cssText}};const r=(t,...e)=>{const i=1===t.length?t[0]:e.reduce((e,i,n)=>e+(t=>{if(!0===t._$cssResult$)return t.cssText;if("number"==typeof t)return t;throw Error("Value passed to 'css' function must be a 'css' function result: "+t+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+t[n+1],t[0]);return new o(i,t,n)},a=i?t=>t:t=>t instanceof CSSStyleSheet?(t=>{let e="";for(const i of t.cssRules)e+=i.cssText;return(t=>new o("string"==typeof t?t:t+"",void 0,n))(e)})(t):t,{is:c,defineProperty:l,getOwnPropertyDescriptor:d,getOwnPropertyNames:h,getOwnPropertySymbols:_,getPrototypeOf:p}=Object,u=globalThis,v=u.trustedTypes,g=v?v.emptyScript:"",f=u.reactiveElementPolyfillSupport,m=(t,e)=>t,b={toAttribute(t,e){switch(e){case Boolean:t=t?g:null;break;case Object:case Array:t=null==t?t:JSON.stringify(t)}return t},fromAttribute(t,e){let i=t;switch(e){case Boolean:i=null!==t;break;case Number:i=null===t?null:Number(t);break;case Object:case Array:try{i=JSON.parse(t)}catch(t){i=null}}return i}},y=(t,e)=>!c(t,e),w={attribute:!0,type:String,converter:b,reflect:!1,useDefault:!1,hasChanged:y};Symbol.metadata??=Symbol("metadata"),u.litPropertyMetadata??=new WeakMap;let $=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??=[]).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,e=w){if(e.state&&(e.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((e=Object.create(e)).wrapped=!0),this.elementProperties.set(t,e),!e.noAccessor){const i=Symbol(),n=this.getPropertyDescriptor(t,i,e);void 0!==n&&l(this.prototype,t,n)}}static getPropertyDescriptor(t,e,i){const{get:n,set:s}=d(this.prototype,t)??{get(){return this[e]},set(t){this[e]=t}};return{get:n,set(e){const o=n?.call(this);s?.call(this,e),this.requestUpdate(t,o,i)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??w}static _$Ei(){if(this.hasOwnProperty(m("elementProperties")))return;const t=p(this);t.finalize(),void 0!==t.l&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(m("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(m("properties"))){const t=this.properties,e=[...h(t),..._(t)];for(const i of e)this.createProperty(i,t[i])}const t=this[Symbol.metadata];if(null!==t){const e=litPropertyMetadata.get(t);if(void 0!==e)for(const[t,i]of e)this.elementProperties.set(t,i)}this._$Eh=new Map;for(const[t,e]of this.elementProperties){const i=this._$Eu(t,e);void 0!==i&&this._$Eh.set(i,t)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){const e=[];if(Array.isArray(t)){const i=new Set(t.flat(1/0).reverse());for(const t of i)e.unshift(a(t))}else void 0!==t&&e.push(a(t));return e}static _$Eu(t,e){const i=e.attribute;return!1===i?void 0:"string"==typeof i?i:"string"==typeof t?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??=new Set).add(t),void 0!==this.renderRoot&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){const t=new Map,e=this.constructor.elementProperties;for(const i of e.keys())this.hasOwnProperty(i)&&(t.set(i,this[i]),delete this[i]);t.size>0&&(this._$Ep=t)}createRenderRoot(){const t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((t,n)=>{if(i)t.adoptedStyleSheets=n.map(t=>t instanceof CSSStyleSheet?t:t.styleSheet);else for(const i of n){const n=document.createElement("style"),s=e.litNonce;void 0!==s&&n.setAttribute("nonce",s),n.textContent=i.cssText,t.appendChild(n)}})(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,e,i){this._$AK(t,i)}_$ET(t,e){const i=this.constructor.elementProperties.get(t),n=this.constructor._$Eu(t,i);if(void 0!==n&&!0===i.reflect){const s=(void 0!==i.converter?.toAttribute?i.converter:b).toAttribute(e,i.type);this._$Em=t,null==s?this.removeAttribute(n):this.setAttribute(n,s),this._$Em=null}}_$AK(t,e){const i=this.constructor,n=i._$Eh.get(t);if(void 0!==n&&this._$Em!==n){const t=i.getPropertyOptions(n),s="function"==typeof t.converter?{fromAttribute:t.converter}:void 0!==t.converter?.fromAttribute?t.converter:b;this._$Em=n;const o=s.fromAttribute(e,t.type);this[n]=o??this._$Ej?.get(n)??o,this._$Em=null}}requestUpdate(t,e,i){if(void 0!==t){const n=this.constructor,s=this[t];if(i??=n.getPropertyOptions(t),!((i.hasChanged??y)(s,e)||i.useDefault&&i.reflect&&s===this._$Ej?.get(t)&&!this.hasAttribute(n._$Eu(t,i))))return;this.C(t,e,i)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(t,e,{useDefault:i,reflect:n,wrapped:s},o){i&&!(this._$Ej??=new Map).has(t)&&(this._$Ej.set(t,o??e??this[t]),!0!==s||void 0!==o)||(this._$AL.has(t)||(this.hasUpdated||i||(e=void 0),this._$AL.set(t,e)),!0===n&&this._$Em!==t&&(this._$Eq??=new Set).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(t){Promise.reject(t)}const t=this.scheduleUpdate();return null!=t&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[t,e]of this._$Ep)this[t]=e;this._$Ep=void 0}const t=this.constructor.elementProperties;if(t.size>0)for(const[e,i]of t){const{wrapped:t}=i,n=this[e];!0!==t||this._$AL.has(e)||void 0===n||this.C(e,void 0,i,n)}}let t=!1;const e=this._$AL;try{t=this.shouldUpdate(e),t?(this.willUpdate(e),this._$EO?.forEach(t=>t.hostUpdate?.()),this.update(e)):this._$EM()}catch(e){throw t=!1,this._$EM(),e}t&&this._$AE(e)}willUpdate(t){}_$AE(t){this._$EO?.forEach(t=>t.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&=this._$Eq.forEach(t=>this._$ET(t,this[t])),this._$EM()}updated(t){}firstUpdated(t){}};$.elementStyles=[],$.shadowRootOptions={mode:"open"},$[m("elementProperties")]=new Map,$[m("finalized")]=new Map,f?.({ReactiveElement:$}),(u.reactiveElementVersions??=[]).push("2.1.1");const x=globalThis,C=x.trustedTypes,A=C?C.createPolicy("lit-html",{createHTML:t=>t}):void 0,E="$lit$",T=`lit$${Math.random().toFixed(9).slice(2)}$`,S="?"+T,k=`<${S}>`,P=document,R=()=>P.createComment(""),V=t=>null===t||"object"!=typeof t&&"function"!=typeof t,O=Array.isArray,M="[ \t\n\f\r]",H=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,U=/-->/g,N=/>/g,j=RegExp(`>|${M}(?:([^\\s"'>=/]+)(${M}*=${M}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),D=/'/g,I=/"/g,W=/^(?:script|style|textarea|title)$/i,F=(t=>(e,...i)=>({_$litType$:t,strings:e,values:i}))(1),z=Symbol.for("lit-noChange"),L=Symbol.for("lit-nothing"),B=new WeakMap,G=P.createTreeWalker(P,129);function q(t,e){if(!O(t)||!t.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==A?A.createHTML(e):e}const K=(t,e)=>{const i=t.length-1,n=[];let s,o=2===e?"<svg>":3===e?"<math>":"",r=H;for(let e=0;e<i;e++){const i=t[e];let a,c,l=-1,d=0;for(;d<i.length&&(r.lastIndex=d,c=r.exec(i),null!==c);)d=r.lastIndex,r===H?"!--"===c[1]?r=U:void 0!==c[1]?r=N:void 0!==c[2]?(W.test(c[2])&&(s=RegExp("</"+c[2],"g")),r=j):void 0!==c[3]&&(r=j):r===j?">"===c[0]?(r=s??H,l=-1):void 0===c[1]?l=-2:(l=r.lastIndex-c[2].length,a=c[1],r=void 0===c[3]?j:'"'===c[3]?I:D):r===I||r===D?r=j:r===U||r===N?r=H:(r=j,s=void 0);const h=r===j&&t[e+1].startsWith("/>")?" ":"";o+=r===H?i+k:l>=0?(n.push(a),i.slice(0,l)+E+i.slice(l)+T+h):i+T+(-2===l?e:h)}return[q(t,o+(t[i]||"<?>")+(2===e?"</svg>":3===e?"</math>":"")),n]};class Y{constructor({strings:t,_$litType$:e},i){let n;this.parts=[];let s=0,o=0;const r=t.length-1,a=this.parts,[c,l]=K(t,e);if(this.el=Y.createElement(c,i),G.currentNode=this.el.content,2===e||3===e){const t=this.el.content.firstChild;t.replaceWith(...t.childNodes)}for(;null!==(n=G.nextNode())&&a.length<r;){if(1===n.nodeType){if(n.hasAttributes())for(const t of n.getAttributeNames())if(t.endsWith(E)){const e=l[o++],i=n.getAttribute(t).split(T),r=/([.?@])?(.*)/.exec(e);a.push({type:1,index:s,name:r[2],strings:i,ctor:"."===r[1]?tt:"?"===r[1]?et:"@"===r[1]?it:X}),n.removeAttribute(t)}else t.startsWith(T)&&(a.push({type:6,index:s}),n.removeAttribute(t));if(W.test(n.tagName)){const t=n.textContent.split(T),e=t.length-1;if(e>0){n.textContent=C?C.emptyScript:"";for(let i=0;i<e;i++)n.append(t[i],R()),G.nextNode(),a.push({type:2,index:++s});n.append(t[e],R())}}}else if(8===n.nodeType)if(n.data===S)a.push({type:2,index:s});else{let t=-1;for(;-1!==(t=n.data.indexOf(T,t+1));)a.push({type:7,index:s}),t+=T.length-1}s++}}static createElement(t,e){const i=P.createElement("template");return i.innerHTML=t,i}}function J(t,e,i=t,n){if(e===z)return e;let s=void 0!==n?i._$Co?.[n]:i._$Cl;const o=V(e)?void 0:e._$litDirective$;return s?.constructor!==o&&(s?._$AO?.(!1),void 0===o?s=void 0:(s=new o(t),s._$AT(t,i,n)),void 0!==n?(i._$Co??=[])[n]=s:i._$Cl=s),void 0!==s&&(e=J(t,s._$AS(t,e.values),s,n)),e}class Z{constructor(t,e){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=e}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){const{el:{content:e},parts:i}=this._$AD,n=(t?.creationScope??P).importNode(e,!0);G.currentNode=n;let s=G.nextNode(),o=0,r=0,a=i[0];for(;void 0!==a;){if(o===a.index){let e;2===a.type?e=new Q(s,s.nextSibling,this,t):1===a.type?e=new a.ctor(s,a.name,a.strings,this,t):6===a.type&&(e=new nt(s,this,t)),this._$AV.push(e),a=i[++r]}o!==a?.index&&(s=G.nextNode(),o++)}return G.currentNode=P,n}p(t){let e=0;for(const i of this._$AV)void 0!==i&&(void 0!==i.strings?(i._$AI(t,i,e),e+=i.strings.length-2):i._$AI(t[e])),e++}}class Q{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,e,i,n){this.type=2,this._$AH=L,this._$AN=void 0,this._$AA=t,this._$AB=e,this._$AM=i,this.options=n,this._$Cv=n?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode;const e=this._$AM;return void 0!==e&&11===t?.nodeType&&(t=e.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,e=this){t=J(this,t,e),V(t)?t===L||null==t||""===t?(this._$AH!==L&&this._$AR(),this._$AH=L):t!==this._$AH&&t!==z&&this._(t):void 0!==t._$litType$?this.$(t):void 0!==t.nodeType?this.T(t):(t=>O(t)||"function"==typeof t?.[Symbol.iterator])(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==L&&V(this._$AH)?this._$AA.nextSibling.data=t:this.T(P.createTextNode(t)),this._$AH=t}$(t){const{values:e,_$litType$:i}=t,n="number"==typeof i?this._$AC(t):(void 0===i.el&&(i.el=Y.createElement(q(i.h,i.h[0]),this.options)),i);if(this._$AH?._$AD===n)this._$AH.p(e);else{const t=new Z(n,this),i=t.u(this.options);t.p(e),this.T(i),this._$AH=t}}_$AC(t){let e=B.get(t.strings);return void 0===e&&B.set(t.strings,e=new Y(t)),e}k(t){O(this._$AH)||(this._$AH=[],this._$AR());const e=this._$AH;let i,n=0;for(const s of t)n===e.length?e.push(i=new Q(this.O(R()),this.O(R()),this,this.options)):i=e[n],i._$AI(s),n++;n<e.length&&(this._$AR(i&&i._$AB.nextSibling,n),e.length=n)}_$AR(t=this._$AA.nextSibling,e){for(this._$AP?.(!1,!0,e);t!==this._$AB;){const e=t.nextSibling;t.remove(),t=e}}setConnected(t){void 0===this._$AM&&(this._$Cv=t,this._$AP?.(t))}}class X{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,e,i,n,s){this.type=1,this._$AH=L,this._$AN=void 0,this.element=t,this.name=e,this._$AM=n,this.options=s,i.length>2||""!==i[0]||""!==i[1]?(this._$AH=Array(i.length-1).fill(new String),this.strings=i):this._$AH=L}_$AI(t,e=this,i,n){const s=this.strings;let o=!1;if(void 0===s)t=J(this,t,e,0),o=!V(t)||t!==this._$AH&&t!==z,o&&(this._$AH=t);else{const n=t;let r,a;for(t=s[0],r=0;r<s.length-1;r++)a=J(this,n[i+r],e,r),a===z&&(a=this._$AH[r]),o||=!V(a)||a!==this._$AH[r],a===L?t=L:t!==L&&(t+=(a??"")+s[r+1]),this._$AH[r]=a}o&&!n&&this.j(t)}j(t){t===L?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}}class tt extends X{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===L?void 0:t}}class et extends X{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==L)}}class it extends X{constructor(t,e,i,n,s){super(t,e,i,n,s),this.type=5}_$AI(t,e=this){if((t=J(this,t,e,0)??L)===z)return;const i=this._$AH,n=t===L&&i!==L||t.capture!==i.capture||t.once!==i.once||t.passive!==i.passive,s=t!==L&&(i===L||n);n&&this.element.removeEventListener(this.name,this,i),s&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}}class nt{constructor(t,e,i){this.element=t,this.type=6,this._$AN=void 0,this._$AM=e,this.options=i}get _$AU(){return this._$AM._$AU}_$AI(t){J(this,t)}}const st=x.litHtmlPolyfillSupport;st?.(Y,Q),(x.litHtmlVersions??=[]).push("3.3.1");const ot=globalThis;let rt=class extends ${constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const t=super.createRenderRoot();return this.renderOptions.renderBefore??=t.firstChild,t}update(t){const e=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=((t,e,i)=>{const n=i?.renderBefore??e;let s=n._$litPart$;if(void 0===s){const t=i?.renderBefore??null;n._$litPart$=s=new Q(e.insertBefore(R(),t),t,void 0,i??{})}return s._$AI(t),s})(e,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return z}};rt._$litElement$=!0,rt.finalized=!0,ot.litElementHydrateSupport?.({LitElement:rt});const at=ot.litElementPolyfillSupport;at?.({LitElement:rt}),(ot.litElementVersions??=[]).push("4.2.1");const ct={attribute:!0,type:String,converter:b,reflect:!1,hasChanged:y},lt=(t=ct,e,i)=>{const{kind:n,metadata:s}=i;let o=globalThis.litPropertyMetadata.get(s);if(void 0===o&&globalThis.litPropertyMetadata.set(s,o=new Map),"setter"===n&&((t=Object.create(t)).wrapped=!0),o.set(i.name,t),"accessor"===n){const{name:n}=i;return{set(i){const s=e.get.call(this);e.set.call(this,i),this.requestUpdate(n,s,t)},init(e){return void 0!==e&&this.C(n,void 0,t,e),e}}}if("setter"===n){const{name:n}=i;return function(i){const s=this[n];e.call(this,i),this.requestUpdate(n,s,t)}}throw Error("Unsupported decorator location: "+n)};function dt(t){return(e,i)=>"object"==typeof i?lt(t,e,i):((t,e,i)=>{const n=e.hasOwnProperty(i);return e.constructor.createProperty(i,t),n?Object.getOwnPropertyDescriptor(e,i):void 0})(t,e,i)}function ht(t){return dt({...t,state:!0,attribute:!1})}const _t=2;class pt{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,e,i){this._$Ct=t,this._$AM=e,this._$Ci=i}_$AS(t,e){return this.update(t,e)}update(t,e){return this.render(...e)}}const ut=(t,e)=>{const i=t._$AN;if(void 0===i)return!1;for(const t of i)t._$AO?.(e,!1),ut(t,e);return!0},vt=t=>{let e,i;do{if(void 0===(e=t._$AM))break;i=e._$AN,i.delete(t),t=e}while(0===i?.size)},gt=t=>{for(let e;e=t._$AM;t=e){let i=e._$AN;if(void 0===i)e._$AN=i=new Set;else if(i.has(t))break;i.add(t),bt(e)}};function ft(t){void 0!==this._$AN?(vt(this),this._$AM=t,gt(this)):this._$AM=t}function mt(t,e=!1,i=0){const n=this._$AH,s=this._$AN;if(void 0!==s&&0!==s.size)if(e)if(Array.isArray(n))for(let t=i;t<n.length;t++)ut(n[t],!1),vt(n[t]);else null!=n&&(ut(n,!1),vt(n));else ut(this,t)}const bt=t=>{t.type==_t&&(t._$AP??=mt,t._$AQ??=ft)};class yt extends pt{constructor(){super(...arguments),this._$AN=void 0}_$AT(t,e,i){super._$AT(t,e,i),gt(this),this.isConnected=t._$AU}_$AO(t,e=!0){t!==this.isConnected&&(this.isConnected=t,t?this.reconnected?.():this.disconnected?.()),e&&(ut(this,t),vt(this))}setValue(t){if((t=>void 0===t.strings)(this._$Ct))this._$Ct._$AI(t,this);else{const e=[...this._$Ct._$AH];e[this._$Ci]=t,this._$Ct._$AI(e,this,0)}}disconnected(){}reconnected(){}}const wt=new WeakMap,$t=(t=>(...e)=>({_$litDirective$:t,values:e}))(class extends yt{render(t){return L}update(t,[e]){const i=e!==this.G;return i&&void 0!==this.G&&this.rt(void 0),(i||this.lt!==this.ct)&&(this.G=e,this.ht=t.options?.host,this.rt(this.ct=t.element)),L}rt(t){if(this.isConnected||(t=void 0),"function"==typeof this.G){const e=this.ht??globalThis;let i=wt.get(e);void 0===i&&(i=new WeakMap,wt.set(e,i)),void 0!==i.get(this.G)&&this.G.call(this.ht,void 0),i.set(this.G,t),void 0!==t&&this.G.call(this.ht,t)}else this.G.value=t}get lt(){return"function"==typeof this.G?wt.get(this.ht??globalThis)?.get(this.G):this.G?.value}disconnected(){this.lt===this.ct&&this.rt(void 0)}reconnected(){this.rt(this.ct)}});function xt(t,e,i){const n=new URLSearchParams;i?.bbox&&n.set("bbox","1"),i?.crop&&n.set("crop","1"),i?.timestamp&&n.set("timestamp","1"),i?.cacheBust&&n.set("h",String(i.cacheBust));const s=n.toString();return`/api/frigate/${encodeURIComponent(t)}/notifications/${encodeURIComponent(e)}/snapshot.jpg${s?"?"+s:""}`}function Ct(t,e){return`/api/frigate/${encodeURIComponent(t)}/notifications/${encodeURIComponent(e)}/clip.mp4`}function At(t,e){return`/api/frigate/${encodeURIComponent(t)}/notifications/${encodeURIComponent(e)}/master.m3u8`}var Et;const Tt="2.2.24",St=[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}],kt={frigate_client_id:"frigate",event_count:5,show_label:!0,show_timestamp:!0,show_date:!1,show_accuracy:!1,show_duration:!1,show_description:!0,show_camera_name:!0,show_zones:!0,show_bounding_box:!0,show_modal_navigation:!1,title:"Frigate Events",video:!0,video_on_hover:!0,muted:!0,offset:0,reverse:!1,video_start_skip_seconds:0,video_end_skip_seconds:0,debug:!1,tracking_smoothing:1,scroll:!0,scroll_limit:20,show_scroll_arrows:!1,layout:"row",grid_max_height:"400px"},Pt={person:"🚶",car:"🚗",dog:"🐕",cat:"🐈",bird:"🐦",motorcycle:"🏍️",bicycle:"🚲",truck:"🚚",bus:"🚌",boat:"🚤"};let Rt=Et=class extends rt{constructor(){super(...arguments),this._events=[],this._loading=!0,this._hoverVideoCropPositions=new WeakMap,this._liveVideoEl=null}_getDailyResetTimestamp(){if(!this._config?.daily_clear_time)return null;const[t,e]=this._config.daily_clear_time.split(":").map(Number);if(isNaN(t)||isNaN(e))return null;const i=new Date,n=new Date(i);return n.setHours(t,e,0,0),i<n&&n.setDate(n.getDate()-1),n.getTime()/1e3}static getConfigElement(){return null}static getStubConfig(){return{frigate_client_id:"frigate",event_count:5}}setConfig(t){if(!t)throw new Error("Invalid configuration");this._config={...kt,...t}}getCardSize(){return 3}getLayoutOptions(){return{grid_columns:4}}async firstUpdated(){await this._loadEvents(),await this._subscribeToEvents(),this._setupVisibilityHandler(),this._setupPolling(),this._setupLiveView()}updated(t){if(t.has("hass")&&this.hass&&!this._unsubscribe&&this._subscribeToEvents(),t.has("_config")){const e=t.get("_config");void 0===e||e.live_view===this._config?.live_view&&e.live_view_entity===this._config?.live_view_entity||(this._teardownWebRTC(),this._intersectionObserver?.disconnect(),this._intersectionObserver=void 0,this._liveViewError=void 0,this._setupLiveView())}}disconnectedCallback(){super.disconnectedCallback(),this._cleanup()}_cleanup(){this._unsubscribe&&(this._unsubscribe(),this._unsubscribe=void 0),this._pollInterval&&(clearInterval(this._pollInterval),this._pollInterval=void 0),this._boundVisibilityHandler&&(document.removeEventListener("visibilitychange",this._boundVisibilityHandler),this._boundVisibilityHandler=void 0),this._teardownWebRTC(),this._intersectionGraceTimer&&(clearTimeout(this._intersectionGraceTimer),this._intersectionGraceTimer=void 0),this._intersectionObserver?.disconnect(),this._intersectionObserver=void 0,this._removeModal()}_setupVisibilityHandler(){this._boundVisibilityHandler=()=>{"visible"===document.visibilityState&&(console.debug("Frigate Events Card: Page became visible, refreshing..."),this._loadEvents(),this._unsubscribe&&(this._unsubscribe(),this._unsubscribe=void 0),this._subscribeToEvents())},document.addEventListener("visibilitychange",this._boundVisibilityHandler)}_setupPolling(){this._pollInterval=window.setInterval(()=>{"visible"===document.visibilityState&&this._loadEvents()},1e4)}_setupLiveView(){if(!this._config?.live_view)return;const t=this._config.live_view_entity;return t?t.startsWith("camera.")?(this._intersectionObserver=new IntersectionObserver(t=>{const e=t.some(t=>t.isIntersecting);e?(this._intersectionGraceTimer&&(clearTimeout(this._intersectionGraceTimer),this._intersectionGraceTimer=void 0),this._peerConnection||this._startWebRTC()):this._intersectionGraceTimer||(this._intersectionGraceTimer=window.setTimeout(()=>{this._intersectionGraceTimer=void 0,this._teardownWebRTC()},1e4))},{threshold:.1}),void this._intersectionObserver.observe(this)):(console.warn(`Frigate Events Card: live_view_entity "${t}" must be a camera entity (must start with "camera.").`),void(this._liveViewError=`"${t}" is not a camera entity`)):(console.warn("Frigate Events Card: live_view is enabled but live_view_entity is not set."),void(this._liveViewError="live_view_entity is required when live_view is true"))}async _startWebRTC(){if(!this.hass||!this._config?.live_view_entity)return;const t=this._config.live_view_entity;if(!this._config?.go2rtc_url&&!this.hass.states[t])return console.warn(`Frigate Events Card: Camera entity "${t}" not found in Home Assistant.`),void(this._liveViewError=`Entity "${t}" not found`);if("undefined"==typeof RTCPeerConnection)return console.warn("Frigate Events Card: WebRTC is not supported in this context. HTTPS is required."),void(this._liveViewError="WebRTC unavailable — HTTPS required");if(this._config.go2rtc_url){const e=this._config.go2rtc_stream||t.replace(/^camera\./,"");return void await this._startGo2rtcWebRTC(this._config.go2rtc_url,e)}try{const e=new RTCPeerConnection({iceServers:St});this._peerConnection=e;const i=new MediaStream;this._remoteStream=i,this._liveVideoEl&&this._liveVideoEl.srcObject!==i&&(this._liveVideoEl.srcObject=i,this._liveVideoEl.play().catch(()=>{})),e.ontrack=t=>{t.streams[0]?.getTracks().forEach(t=>i.addTrack(t))},e.addTransceiver("video",{direction:"recvonly"});const n=await e.createOffer();await e.setLocalDescription(n);const s=await new Promise(t=>{if("complete"===e.iceGatheringState)return void t(e.localDescription.sdp);e.onicegatheringstatechange=()=>{"complete"===e.iceGatheringState&&t(e.localDescription.sdp)},setTimeout(()=>t(e.localDescription?.sdp||n.sdp),3e3)});this._liveViewUnsub=await this.hass.connection.subscribeMessage(async t=>{if(this._peerConnection&&this._peerConnection===e)switch(t.type){case"session":this._liveViewSessionId=t.session_id;break;case"answer":try{await e.setRemoteDescription(new RTCSessionDescription({type:"answer",sdp:t.answer})),this._liveViewError=void 0}catch(t){console.error("Frigate Events Card: Failed to set WebRTC remote description:",t),this._liveViewError="Stream negotiation failed",this._teardownWebRTC()}break;case"candidate":try{await e.addIceCandidate(new RTCIceCandidate(t.candidate))}catch{}break;case"error":console.warn(`Frigate Events Card: WebRTC stream error (${t.code}): ${t.message}`),this._liveViewError=t.message||"Camera stream unavailable",this._teardownWebRTC()}},{type:"camera/web_rtc_offer",entity_id:t,offer:s}),e.onicecandidate=({candidate:t})=>{t&&this._liveViewSessionId&&this.hass&&this.hass.callWS({type:"camera/web_rtc_candidate",session_id:this._liveViewSessionId,candidate:t.toJSON()}).catch(()=>{})},this._setupWebRTCMonitoring(e)}catch(t){let e=t?.message||("object"==typeof t?JSON.stringify(t):String(t));("unknown_command"===t?.code||e.toLowerCase().includes("unknown command"))&&(e="HA WebRTC protocol (camera/web_rtc_offer) not supported for this entity. Fix WebRTC Camera integration in HA or set go2rtc_url in card config."),console.error("Frigate Events Card: Failed to start WebRTC session:",e),this._liveViewError=`Failed to start: ${e}`,this._teardownWebRTC()}}async _startGo2rtcWebRTC(t,e){try{const i=new RTCPeerConnection({iceServers:St});this._peerConnection=i;const n=new MediaStream;this._remoteStream=n,this._liveVideoEl&&this._liveVideoEl.srcObject!==n&&(this._liveVideoEl.srcObject=n,this._liveVideoEl.play().catch(()=>{})),i.ontrack=t=>{t.streams[0]?.getTracks().forEach(t=>n.addTrack(t))},i.addTransceiver("video",{direction:"recvonly"});const s=await i.createOffer();await i.setLocalDescription(s);const o=await new Promise(t=>{if("complete"===i.iceGatheringState)return void t(i.localDescription.sdp);i.onicegatheringstatechange=()=>{"complete"===i.iceGatheringState&&t(i.localDescription.sdp)},setTimeout(()=>t(i.localDescription?.sdp||s.sdp),3e3)}),r=t.replace(/\/+$/,""),a=await fetch(`${r}/api/webrtc?src=${encodeURIComponent(e)}`,{method:"POST",body:o});if(!a.ok)throw new Error(`go2rtc returned HTTP ${a.status}: ${a.statusText}`);const c=await a.text();let l=c;try{const t=JSON.parse(c);if(t.sdp)l=t.sdp;else if(t.error)throw new Error(t.error)}catch(t){if(t.message&&!t.message.includes("JSON")&&!t.message.includes("Unexpected token"))throw t}await i.setRemoteDescription(new RTCSessionDescription({type:"answer",sdp:l})),this._liveViewError=void 0,this._setupWebRTCMonitoring(i)}catch(t){const e=t?.message||String(t);console.error("Frigate Events Card: Failed direct go2rtc WebRTC session:",e),this._liveViewError=`Failed go2rtc stream: ${e}`,this._teardownWebRTC()}}_teardownWebRTC(){this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0),this._peerConnection&&(this._peerConnection.ontrack=null,this._peerConnection.onicecandidate=null,this._peerConnection.onconnectionstatechange=null,this._peerConnection.oniceconnectionstatechange=null,this._peerConnection.onicegatheringstatechange=null,this._peerConnection.close(),this._peerConnection=void 0),this._liveViewUnsub&&(this._liveViewUnsub(),this._liveViewUnsub=void 0),this._liveViewSessionId&&this.hass&&(this.hass.callWS({type:"camera/close_webrtc_session",session_id:this._liveViewSessionId}).catch(()=>{}),this._liveViewSessionId=void 0),this._liveVideoEl&&(this._liveVideoEl.srcObject=null),this._remoteStream&&(this._remoteStream.getTracks().forEach(t=>t.stop()),this._remoteStream=void 0)}_setupWebRTCMonitoring(t){const e=()=>{const e=t.connectionState,i=t.iceConnectionState;console.debug(`Frigate Events Card: WebRTC state → connection: ${e}, ice: ${i}`),"connected"===e||"connected"===i||"completed"===i?this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0):"failed"===e||"failed"===i?(this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0),console.warn("Frigate Events Card: WebRTC connection failed; auto-reconnecting in 5s."),this._teardownWebRTC(),window.setTimeout(()=>{this._intersectionObserver&&!this._peerConnection&&this._startWebRTC()},5e3)):"disconnected"!==e&&"disconnected"!==i||this._disconnectTimer||(console.warn("Frigate Events Card: WebRTC stream disconnected; starting 10s self-healing timer..."),this._disconnectTimer=window.setTimeout(()=>{this._disconnectTimer=void 0,this._peerConnection!==t||"disconnected"!==t.connectionState&&"disconnected"!==t.iceConnectionState||(console.warn("Frigate Events Card: WebRTC stream remained disconnected for 10s. Triggering self-healing restart."),this._teardownWebRTC(),this._startWebRTC())},1e4))};t.onconnectionstatechange=e,t.oniceconnectionstatechange=e}async _loadEvents(){if(this.hass&&this._config){this._error=void 0;try{const t=!!this._config.scroll,e=this._config.event_count||5,i=this._config.scroll_limit||20,n=(t?i:e)+(this._config.offset||0),s=await async function(t,e){const i=await t.callWS({type:"frigate/events/get",...e});return JSON.parse(i)}(this.hass,{instance_id:this._config.frigate_client_id,cameras:this._config.cameras,labels:this._config.labels,zones:this._config.zones,limit:n,has_snapshot:!0});this._events=s.sort((t,e)=>(e.start_time||0)-(t.start_time||0))}catch(t){console.error("Failed to load Frigate events:",t),this._error="Failed to load events"}finally{this._loading=!1}}}async _subscribeToEvents(){if(this.hass&&this._config&&!this._unsubscribe)try{this._unsubscribe=await async function(t,e,i){const n=await t.connection.subscribeMessage(t=>{try{const e=JSON.parse(t);i(e)}catch(t){console.warn("Failed to parse Frigate event:",t)}},{type:"frigate/events/subscribe",instance_id:e});return n}(this.hass,this._config.frigate_client_id||"frigate",t=>{this._matchesFilters(t)&&("new"!==t.type&&"end"!==t.type||this._loadEvents())})}catch(t){console.warn("Failed to subscribe to Frigate events:",t)}}_matchesFilters(t){const e=this._config;if(!e)return!0;const i=t.after;if(e.cameras?.length&&!e.cameras.includes(i.camera))return!1;if(e.labels?.length&&!e.labels.includes(i.label))return!1;if(e.zones?.length){const t=e.zones.some(t=>i.current_zones.includes(t));if(!t)return!1}return!0}_handleRefresh(){this._loadEvents()}_handleEventClick(t){this._selectedEvent=t,this._showModal()}_handleModalClose(){this._selectedEvent=void 0,this._removeModal()}_injectModalStyles(){if(Et._stylesInjected)return;const t="frigate-events-card-modal-styles";if(document.getElementById(t))return void(Et._stylesInjected=!0);const e=document.createElement("style");e.id=t,e.textContent="\n      .frigate-events-modal {\n        position: fixed;\n        top: 0;\n        left: 0;\n        width: 100%;\n        height: 100%;\n        background: rgba(0, 0, 0, 0.85);\n        z-index: 9999;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        padding: 20px;\n        box-sizing: border-box;\n        backdrop-filter: blur(5px);\n        animation: frigate-modal-fade-in 0.2s forwards;\n      }\n\n      @keyframes frigate-modal-fade-in {\n        from { opacity: 0; }\n        to { opacity: 1; }\n      }\n\n      .frigate-events-modal-content {\n        position: relative;\n        width: fit-content;\n        min-width: 450px;\n        max-width: 90%;\n        max-height: 90%;\n        background: var(--card-background-color, #1c1c1c);\n        border-radius: 12px;\n        overflow: hidden;\n        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);\n        display: flex;\n        flex-direction: column;\n        animation: frigate-modal-slide-up 0.2s forwards;\n      }\n\n      @keyframes frigate-modal-slide-up {\n        from { transform: translateY(20px); opacity: 0; }\n        to { transform: translateY(0); opacity: 1; }\n      }\n\n      .frigate-events-modal-image-container {\n        position: relative;\n        display: flex;\n        justify-content: center;\n        background: black;\n      }\n\n      .frigate-events-modal-image-container img,\n      .frigate-events-modal-image-container video {\n        max-width: 100%;\n        max-height: 55vh;\n        width: auto;\n        height: auto;\n        display: block;\n      }\n\n      .frigate-events-modal-close {\n        position: absolute;\n        top: 10px;\n        right: 10px;\n        background: rgba(0, 0, 0, 0.5);\n        color: white;\n        width: 32px;\n        height: 32px;\n        border-radius: 50%;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 18px;\n        cursor: pointer;\n        transition: background 0.2s;\n        backdrop-filter: blur(4px);\n        border: none;\n        font-family: inherit;\n      }\n\n      .frigate-events-modal-close:hover {\n        background: rgba(0, 0, 0, 0.8);\n      }\n\n      .frigate-events-modal-nav {\n        position: absolute;\n        top: 50%;\n        transform: translateY(-50%);\n        background: rgba(0, 0, 0, 0.5);\n        color: white;\n        width: 40px;\n        height: 40px;\n        border-radius: 50%;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 20px;\n        cursor: pointer;\n        transition: background 0.2s, opacity 0.2s;\n        backdrop-filter: blur(4px);\n        border: none;\n        font-family: inherit;\n        z-index: 10;\n        user-select: none;\n        line-height: 1;\n      }\n\n      .frigate-events-modal-nav svg {\n        width: 22px;\n        height: 22px;\n        fill: currentColor;\n        display: block;\n      }\n\n      .frigate-events-modal-nav:hover {\n        background: rgba(0, 0, 0, 0.8);\n      }\n\n      .frigate-events-modal-nav.prev {\n        left: 10px;\n      }\n\n      .frigate-events-modal-nav.next {\n        right: 10px;\n      }\n\n      .frigate-events-modal-info {\n        padding: 16px;\n        background: var(--card-background-color, #1c1c1c);\n        display: flex;\n        flex-direction: column;\n        gap: 12px;\n        width: 0;\n        min-width: 100%;\n        box-sizing: border-box;\n      }\n\n      .frigate-events-modal-info-top {\n        display: flex;\n        justify-content: space-between;\n        align-items: flex-start;\n        gap: 16px;\n        width: 100%;\n      }\n\n      .frigate-events-modal-info-left {\n        display: flex;\n        flex-direction: column;\n        gap: 4px;\n        min-width: 0;\n        flex: 1;\n      }\n\n      .frigate-events-modal-info-center {\n        display: flex;\n        flex: 2;\n        align-items: center;\n        justify-content: center;\n        text-align: center;\n        min-width: 0;\n        padding: 0 16px;\n        align-self: center;\n      }\n\n      .frigate-events-modal-info-right {\n        display: flex;\n        flex-direction: column;\n        align-items: flex-end;\n        gap: 4px;\n        flex: 1;\n        flex-shrink: 0;\n        text-align: right;\n      }\n\n      .frigate-events-modal-label {\n        font-size: 20px;\n        font-weight: 600;\n        color: var(--primary-text-color, #fff);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-camera {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-time {\n        font-size: 20px;\n        font-weight: 500;\n        color: var(--primary-text-color, #fff);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-zones {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-duration {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-score {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-description-row {\n        border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.15));\n        padding-top: 12px;\n        margin-top: 4px;\n        width: 100%;\n        max-height: 90px;\n        overflow-y: auto;\n      }\n\n      .frigate-events-modal-description-row::-webkit-scrollbar {\n        width: 6px;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-track {\n        background: transparent;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-thumb {\n        background-color: rgba(255, 255, 255, 0.15);\n        border-radius: 3px;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-thumb:hover {\n        background-color: rgba(255, 255, 255, 0.35);\n      }\n\n      .frigate-events-modal-description {\n        font-size: 13px;\n        line-height: 1.5;\n        color: var(--primary-text-color, #e0e0e0);\n        font-style: italic;\n        white-space: pre-wrap;\n      }\n    ",document.head.appendChild(e),Et._stylesInjected=!0}_getConfigValueForEvent(t,e,i){if(null==t)return i;if("number"==typeof t)return t;const n=e.label,s=e.zones||[];for(const e of s){const i=`${n}:${e}`;if(void 0!==t[i])return t[i];const s=`${e}:${n}`;if(void 0!==t[s])return t[s]}if(void 0!==t[n])return t[n];for(const e of s)if(void 0!==t[e])return t[e];return void 0!==t.default?t.default:i}_getVideoTimeParam(t){const e=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,t,0);return e>0?`#t=${e}`:""}_getEventsToShow(){if(!this._config)return[];const t=!!this._config.scroll,e=this._config.event_count||5,i=this._config.scroll_limit||20,n=t?i:e;let s=this._events;const o=this._getDailyResetTimestamp();null!==o&&(s=this._events.filter(t=>(t.start_time||0)>o));const r=this._config.offset||0,a=s.slice(r,r+n);return this._config.reverse?[...a].reverse():a}_navigateToEvent(t){if(!this._selectedEvent)return;const e=this._getEventsToShow(),i=e.findIndex(t=>t.id===this._selectedEvent?.id);if(-1===i)return;let n=i;"next"===t?n=i+1:"prev"===t&&(n=i-1),n>=0&&n<e.length&&(this._selectedEvent=e[n],this._showModal())}_handleKeyDown(t){this._selectedEvent&&("ArrowRight"===t.key?this._navigateToEvent("next"):"ArrowLeft"===t.key?this._navigateToEvent("prev"):"Escape"===t.key&&this._handleModalClose())}_showModal(){if(!this._selectedEvent)return;console.log("Frigate Events Card: event clicked =",this._selectedEvent),this._injectModalStyles();const t=!!this._modalContainer;t&&this._boundKeyDownHandler&&(window.removeEventListener("keydown",this._boundKeyDownHandler),this._boundKeyDownHandler=void 0);const e=this._selectedEvent,i=this._config?.frigate_client_id||"frigate",n=xt(i,e.id,{bbox:!1!==this._config?.show_bounding_box,timestamp:!0,cacheBust:e.end_time||void 0}),s=this._formatDuration(e.start_time,e.end_time),o=this._formatZones(e.zones);t||(this._modalContainer=document.createElement("div"),this._modalContainer.className="frigate-events-modal",this._modalContainer.addEventListener("click",()=>this._handleModalClose()));const r=!!this._config?.video,a=this._getVideoTimeParam(e),c=Ct(i,e.id)+a,l=At(i,e.id)+a,d=e.data?.top_score??e.top_score??e.data?.score,h=null!=d?`${Math.round(100*d)}%`:"",_=this._formatTime(e.start_time),p=`${this._config?.show_date?`${this._formatDate(e.start_time)} · `:""}${_}`,u=!!this._config?.show_duration,v=!!this._config?.show_accuracy,g=!1!==this._config?.show_description,f=!1!==this._config?.show_camera_name,m=!1!==this._config?.show_zones,b=this._getEventsToShow(),y=b.findIndex(t=>t.id===e.id),w=y>0,$=-1!==y&&y<b.length-1,x=!!this._config?.show_modal_navigation,C=x&&w?'<button class="frigate-events-modal-nav prev" title="Previous event">\n           <svg viewBox="0 0 24 24">\n             <path d="M15,6L9,12L15,18Z" fill="currentColor"/>\n           </svg>\n         </button>':"",A=x&&$?'<button class="frigate-events-modal-nav next" title="Next event">\n           <svg viewBox="0 0 24 24">\n             <path d="M9,6L15,12L9,18Z" fill="currentColor"/>\n           </svg>\n         </button>':"",E=this._modalContainer;if(!E)return;E.innerHTML=`\n      <div class="frigate-events-modal-content">\n        <div class="frigate-events-modal-image-container">\n          ${C}\n          ${r?`<video autoplay ${this._config?.muted?"muted":""} controls playsinline>\n                 <source src="${c}" type="video/mp4">\n                 <source src="${l}" type="application/x-mpegURL">\n               </video>`:`<img src="${n}" alt="${e.label}" />`}          ${A}\n          <button class="frigate-events-modal-close">x</button>\n        </div>\n        <div class="frigate-events-modal-info">\n          <div class="frigate-events-modal-info-top">\n            <div class="frigate-events-modal-info-left">\n              <div class="frigate-events-modal-label">\n                ${this._capitalize(e.label)}\n              </div>\n              ${f?`<div class="frigate-events-modal-camera">\n                     ${this._formatCameraName(e.camera)}\n                   </div>`:""}\n              ${v&&h?`<div class="frigate-events-modal-score">${h}</div>`:""}\n            </div>\n            \n            <div class="frigate-events-modal-info-right">\n              <div class="frigate-events-modal-time">${p}</div>\n              ${m&&o?`<div class="frigate-events-modal-zones">${o}</div>`:""}\n              ${u?`<div class="frigate-events-modal-duration">${s}</div>`:""}\n            </div>\n          </div>\n          ${g&&(e.description||e.data?.description)?`<div class="frigate-events-modal-description-row">\n                 <div class="frigate-events-modal-description">${e.description||e.data?.description}</div>\n               </div>`:""}\n        </div>\n      </div>\n    `;const T=E.querySelector("video");T&&(T.muted=!1!==this._config?.muted);const S=E.querySelector(".frigate-events-modal-content");S?.addEventListener("click",t=>t.stopPropagation());const k=E.querySelector(".frigate-events-modal-close");if(k?.addEventListener("click",()=>this._handleModalClose()),x&&w){const t=E.querySelector(".frigate-events-modal-nav.prev");t?.addEventListener("click",t=>{t.stopPropagation(),this._navigateToEvent("prev")})}if(x&&$){const t=E.querySelector(".frigate-events-modal-nav.next");t?.addEventListener("click",t=>{t.stopPropagation(),this._navigateToEvent("next")})}this._boundKeyDownHandler=t=>this._handleKeyDown(t),window.addEventListener("keydown",this._boundKeyDownHandler),t||document.body.appendChild(E)}_removeModal(){this._modalContainer&&this._modalContainer.parentNode&&(this._modalContainer.parentNode.removeChild(this._modalContainer),this._modalContainer=void 0),this._boundKeyDownHandler&&(window.removeEventListener("keydown",this._boundKeyDownHandler),this._boundKeyDownHandler=void 0)}_formatTime(t){return new Date(1e3*t).toLocaleTimeString(void 0,{hour:"numeric",minute:"2-digit",second:"2-digit"}).toUpperCase()}_formatDate(t){return new Date(1e3*t).toLocaleDateString(void 0,{month:"short",day:"numeric",year:"numeric"})}_formatDuration(t,e){if(!e)return"Ongoing";const i=Math.round(e-t);if(i<60)return`${i}s`;const n=Math.floor(i/60),s=i%60;return s>0?`${n}m ${s}s`:`${n}m`}_formatZones(t){return t&&0!==t.length?t.map(t=>t.replace(/_/g," ").replace(/\b\w/g,t=>t.toUpperCase())).join(", "):""}_isValidBoundingBox(t){return Array.isArray(t)&&4===t.length&&t.every(t=>"number"==typeof t&&Number.isFinite(t))&&(t[2]>t[0]&&t[3]>t[1]||t[2]>0&&t[3]>0)}_isNormalizedBox(t){return t.every(t=>t>=0&&t<=1)}_getEventBoundingBoxCandidate(t){return[{source:"data.snapshot.box",box:t.data?.snapshot?.box},{source:"data.box",box:t.data?.box},{source:"box",box:t.box},{source:"data.snapshot.region",box:t.data?.snapshot?.region},{source:"data.region",box:t.data?.region},{source:"region",box:t.region}].find(t=>this._isValidBoundingBox(t.box))}_getEventBoundingBox(t){return this._getEventBoundingBoxCandidate(t)?.box}_getBoxCenter(t,e,i){const[n,s,o,r]=t;if(this._isNormalizedBox(t)){const t=n+o/2>1||s+r/2>1;return{x:(t?n:n+o/2)*e,y:(t?s:s+r/2)*i}}return{x:(n+o)/2,y:(s+r)/2}}_getValidPathData(t){return(t.data?.path_data||[]).filter(t=>Array.isArray(t)&&2===t.length&&Array.isArray(t[0])&&2===t[0].length&&t[0].every(t=>"number"==typeof t&&Number.isFinite(t))&&"number"==typeof t[1]&&Number.isFinite(t[1]))}_getInterpolatedPathPoint(t,e,i){const n=this._getValidPathData(t);if(!n.length)return;const s=n[0],o=n[n.length-1];if(i<=s[1])return{x:s[0][0]*e.videoWidth,y:s[0][1]*e.videoHeight};if(i>=o[1])return{x:o[0][0]*e.videoWidth,y:o[0][1]*e.videoHeight};for(let t=1;t<n.length;t++){const s=n[t-1],o=n[t];if(i>o[1])continue;const r=o[1]-s[1],a=r>0?(i-s[1])/r:0,c=a*a*(3-2*a),l=s[0][0]+(o[0][0]-s[0][0])*c,d=s[0][1]+(o[0][1]-s[0][1])*c;return{x:l*e.videoWidth,y:d*e.videoHeight}}return{x:o[0][0]*e.videoWidth,y:o[0][1]*e.videoHeight}}_getSmoothedPathPoint(t,e){if(!t.start_time)return;const i=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,t,0),n=this._getTrackingTimeOffset(t),s=t.start_time+(e.currentTime-i)-n,o=this._config?.tracking_smoothing??1;if(o<=.01)return this._getInterpolatedPathPoint(t,e,s);const r=2*o,a=r/2;let c=0,l=0,d=0;for(let i=0;i<=10;i++){const n=s-a+r*(i/10),o=this._getInterpolatedPathPoint(t,e,n);o&&(c+=o.x,l+=o.y,d++)}return 0!==d?{x:c/d,y:l/d}:void 0}_calculateObjectPositionPercentForPoint(t,e,i){const n=e.videoWidth,s=e.videoHeight,o=e.clientWidth,r=e.clientHeight;if(!(n&&s&&o&&r))return;const a=Math.max(o/n,r/s),c=s*a,l=t=>Math.min(100,Math.max(0,t)),d=(t,e,i,n)=>{if(e<=t+.5)return 50;const s=e-t,o=.2*t,r=i*a;if(void 0!==n){const e=(r-t+o)/s*100,i=(r-o)/s*100;return n>=e&&n<=i?n:l(Math.min(Math.max(n,e),i))}return l((r-t/2)/s*100)};return{x:d(o,n*a,t.x,i?.x),y:d(r,c,t.y,i?.y)}}_formatObjectPosition(t){return`${t.x.toFixed(2)}% ${t.y.toFixed(2)}%`}_calculateObjectPositionPercent(t,e,i){if(e.videoWidth&&e.videoHeight)return this._calculateObjectPositionPercentForPoint(this._getBoxCenter(t,e.videoWidth,e.videoHeight),e,i)}_getTrackingTimeOffset(t){return this._getConfigValueForEvent(this._config?.tracking_pan_delay,t,0)/1e3}_updateHoverVideoObjectPosition(t,e){const i=this._getSmoothedPathPoint(e,t),n=this._getEventBoundingBoxCandidate(e),s=this._hoverVideoCropPositions.get(t),o=this._getTrackingTimeOffset(e),r=i?this._calculateObjectPositionPercentForPoint(i,t,s):n?this._calculateObjectPositionPercent(n.box,t,s):void 0;if(!r)return this._hoverVideoCropPositions.delete(t),t.style.objectPosition="50% 50%","center";const a=s?{x:s.x+.15*(r.x-s.x),y:s.y+.15*(r.y-s.y)}:r;this._hoverVideoCropPositions.set(t,a),t.style.objectPosition=this._formatObjectPosition(a);let c=i?"data.path_data":n?.source??"center";if(0!==o&&(c+=` (${o>0?"+":""}${o}s delay)`),this._config?.debug&&i){const i=this._getValidPathData(e);if(i.length){const n=i[0][1]-(e.start_time||0),s=i[i.length-1][1]-(e.start_time||0),r=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,e,0),a=t.currentTime-r-o;c+=` [V:${t.currentTime.toFixed(1)}s, P:${a.toFixed(1)}s, Range:${n.toFixed(1)}-${s.toFixed(1)}s]`}}return c}_startHoverVideoTracking(t,e){const i=()=>{t.isConnected&&this._hoveredEventId===e.id&&(this._updateHoverVideoObjectPosition(t,e),requestAnimationFrame(i))};requestAnimationFrame(i)}_handleHoverVideoMetadata(t,e){const i=t.currentTarget;if(!(i instanceof HTMLVideoElement))return;const n=this._updateHoverVideoObjectPosition(i,e);if(this._config?.debug){const t=this._getEventBoundingBoxCandidate(e);console.debug("Frigate Events Card: hover crop debug",{eventId:e.id,camera:e.camera,label:e.label,cropSource:n,chosenBoxSource:t?.source??null,chosenBox:t?.box??null,pathDataPoints:this._getValidPathData(e).length,candidateBoxes:{dataSnapshotBox:e.data?.snapshot?.box,dataBox:e.data?.box,box:e.box,dataSnapshotRegion:e.data?.snapshot?.region,dataRegion:e.data?.region,region:e.region},objectPosition:i.style.objectPosition,videoSize:{width:i.videoWidth,height:i.videoHeight},tileSize:{width:i.clientWidth,height:i.clientHeight},event:e})}this._startHoverVideoTracking(i,e)}_handleVideoTimeUpdate(t,e){const i=t.currentTarget,n=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,e,0),s=this._getConfigValueForEvent(this._config?.video_end_skip_seconds,e,0);if(i.duration&&isFinite(i.duration))if(s>0){const t=Math.max(n,i.duration-s);i.currentTime>=t-.1&&(i.currentTime=n,i.play().catch(()=>{}))}else n>0&&i.currentTime<n&&i.currentTime<1&&(i.currentTime=n)}_getLabelIcon(t){return Pt[t.toLowerCase()]||"📷"}render(){if(!this._config)return F`<ha-card>No configuration</ha-card>`;const t="grid"===this._config.layout,e=!t&&!!this._config.scroll,i=e&&!!this._config.show_scroll_arrows,n=this._config.event_count||5,s=this._config.scroll_limit||20,o=this._config.scroll?s:n;let r=this._events;const a=this._getDailyResetTimestamp();null!==a&&(r=this._events.filter(t=>(t.start_time||0)>a));const c=this._config.offset||0,l=r.slice(c,c+o);let d=Math.max(0,(e?n:o)-l.length);if(t&&this._config.grid_columns&&d>0){const t=l.length+d;d=Math.ceil(t/this._config.grid_columns)*this._config.grid_columns-l.length}let h=[...l.map(t=>this._renderEvent(t)),...Array(d).fill(0).map(()=>F`<div class="placeholder"></div>`)];this._config.reverse&&h.reverse();const _=["events",t?"grid":"",t&&this._config.scroll?"scrollable-y":"",!t&&this._config.scroll?"scrollable":""].filter(Boolean).join(" "),p=this._config.grid_columns,u=p?`repeat(${p}, 1fr)`:"repeat(auto-fill, minmax(120px, 1fr))",v=this._config.grid_max_height||"400px",g=t?`grid-template-columns: ${u}; --grid-max-height: ${v};`:`--visible-count: ${n}; --event-count: ${o};`;return F`
      <ha-card>
        <div class="content">
          ${this._config.debug?F`<div class="debug-version">v${Tt}</div>`:""}
          ${this._config.live_view?this._renderLiveView():""}
          ${this._loading?F`<div class="loading"></div>`:this._error?F``:F`
              <div class="events-container">
                ${i?F`
                  <button class="scroll-btn prev" @click=${()=>this._scroll("left")} aria-label="Previous">
                    <svg viewBox="0 0 24 24">
                      <path d="M15,6L9,12L15,18Z" fill="currentColor"/>
                    </svg>
                  </button>
                  <button class="scroll-btn next" @click=${()=>this._scroll("right")} aria-label="Next">
                    <svg viewBox="0 0 24 24">
                      <path d="M9,6L15,12L9,18Z" fill="currentColor"/>
                    </svg>
                  </button>
                `:""}
                <div class="${_}" style="${g}">
                  ${h}
                </div>
              </div>
            `}
        </div>
      </ha-card>
    `}_renderLiveView(){const t=this._config?.live_view_aspect_ratio||"16 / 9";return this._liveViewError?F`
        <div class="live-view-container" style="aspect-ratio: ${t};">
          <div class="live-view-error">
            <span>⚠ Live feed unavailable</span>
            <span class="live-view-error-detail">${this._liveViewError}</span>
          </div>
        </div>
      `:F`
      <div class="live-view-container" style="aspect-ratio: ${t};">
        <video
          class="live-view-video"
          autoplay
          muted
          playsinline
          webkit-playsinline
          disablepictureinpicture
          disableremoteplayback
          poster="data:image/png;base64,iVBORw0KGgoAAAANSU5EUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
          ${$t(t=>{const e=t??null;this._liveVideoEl=e,e&&this._remoteStream&&e.srcObject!==this._remoteStream&&(e.srcObject=this._remoteStream,e.play().catch(()=>{}))})}
        ></video>
      </div>
    `}_renderEvent(t){const e=this._config?.frigate_client_id||"frigate",i=xt(e,t.id,{bbox:!1!==this._config?.show_bounding_box,crop:!0,cacheBust:t.end_time||void 0}),n=this._hoveredEventId===t.id,s=!!this._config?.video_on_hover,o=this._getVideoTimeParam(t),r=Ct(e,t.id)+o,a=At(e,t.id)+o,c=function(t,e){return`/api/frigate/${encodeURIComponent(t)}/thumbnail/${encodeURIComponent(e)}`}(e,t.id);return F`
      <div class="event"
        @click=${()=>this._handleEventClick(t)}
        @mouseenter=${()=>{s&&(this._hoveredEventId=t.id)}}
        @mouseleave=${()=>{s&&(this._hoveredEventId=void 0)}}
        style="position: relative;"
      >
        <img
          src="${i}"
          alt="${t.label}"
          loading="lazy"
          @error=${t=>{const e=t.target;e&&!e.src.includes("/thumbnail/")&&(e.src=c)}}
        />
        ${s&&n?F`<video
                   autoplay
                   muted
                   .muted=${!0}
                   loop
                   playsinline
                   @loadedmetadata=${e=>this._handleHoverVideoMetadata(e,t)}
                   @timeupdate=${e=>this._handleVideoTimeUpdate(e,t)}
                   style="position: absolute; top: 0; left: 0; z-index: 2; width: 100%; height: 100%; object-fit: cover; pointer-events: none;"
                 >
                   <source src="${r}" type="video/mp4">
                   <source src="${a}" type="application/x-mpegURL">
                 </video>`:""}
      </div>
    `}_scroll(t){const e=this.renderRoot.querySelector(".events");if(!e)return;const i=.8*e.clientWidth;e.scrollBy({left:"left"===t?-i:i,behavior:"smooth"})}_capitalize(t){return t.charAt(0).toUpperCase()+t.slice(1)}_formatCameraName(t){return t.replace(/_/g," ").replace(/\b\w/g,t=>t.toUpperCase())}static get styles(){return r`
      :host {
        display: block;
      }

      ha-card {
        overflow: hidden;
        background: transparent;
        box-shadow: none;
        width: 100%;
      }

      .content {
        padding: 0;
      }

      .loading {
        min-height: 80px;
      }

      .events-container {
        position: relative;
        width: 100%;
      }

      .scroll-btn {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.5);
        color: white;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.3s, background-color 0.2s, transform 0.2s;
        backdrop-filter: blur(4px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      .scroll-btn.prev {
        left: 8px;
      }

      .scroll-btn.next {
        right: 8px;
      }

      .scroll-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
        display: block;
      }

      .events-container:hover .scroll-btn {
        opacity: 1;
      }

      .scroll-btn:hover {
        background: rgba(0, 0, 0, 0.8);
        transform: translateY(-50%) scale(1.1);
      }

      .scroll-btn:active {
        transform: translateY(-50%) scale(0.95);
      }

      .events {
        display: grid;
        grid-template-columns: repeat(var(--visible-count, 5), 1fr);
        gap: 9px;
        align-items: start;
      }

      .events.scrollable {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        scroll-behavior: smooth;
        grid-template-columns: none;
        -ms-overflow-style: none;
        scrollbar-width: none;
        align-items: start;
      }

      .events.scrollable::-webkit-scrollbar {
        display: none;
      }

      .events.scrollable .event,
      .events.scrollable .placeholder {
        flex: 0 0 calc((100% - (var(--visible-count, 5) - 1) * 9px) / var(--visible-count, 5));
        scroll-snap-align: start;
        box-sizing: border-box;
      }

      .events.grid {
        display: grid;
        grid-template-columns: var(--grid-template-columns, repeat(auto-fill, minmax(120px, 1fr)));
        gap: 9px;
        align-items: start;
      }

      .events.grid.scrollable-y {
        max-height: var(--grid-max-height, 400px);
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 4px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar {
        width: 6px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-track {
        background: transparent;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.4);
      }

      .event {
        aspect-ratio: 1 / 1;
        cursor: pointer;
        border-radius: 12px;
        overflow: hidden;
        background: var(--secondary-background-color);
        transition: transform 0.2s, opacity 0.2s;
      }

      .event:hover {
        transform: scale(1.02);
        opacity: 0.9;
      }

      .event:active {
        transform: scale(0.98);
      }

      .placeholder {
        aspect-ratio: 1 / 1;
        border-radius: 12px;
        background: #1c1c1c;
      }

      .event img,
      .event video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      
      .debug-version {
        font-size: 10px;
        color: var(--secondary-text-color, #aaa);
        padding: 2px 8px;
        text-align: right;
        font-family: monospace;
        opacity: 0.7;
      }

      /* ─── Live view ────────────────────────────────────────── */

      .live-view-container {
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #000;
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 9px;
        position: relative;
      }

      .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        background-color: #000;
      }

      /* Hide WebKit / Blink default media controls and play button overlays on TV browsers */
      .live-view-video::-webkit-media-controls,
      .live-view-video::-webkit-media-controls-start-playback-button,
      .live-view-video::-webkit-media-controls-play-button,
      .live-view-video::-webkit-media-controls-overlay-play-button,
      .live-view-video::-webkit-media-controls-enclosure {
        display: none !important;
        -webkit-appearance: none !important;
      }

      .live-view-error {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: var(--secondary-text-color, #aaa);
        font-size: 13px;
      }

      .live-view-error-detail {
        font-size: 11px;
        opacity: 0.7;
        max-width: 80%;
        text-align: center;
      }

    `}};Rt._stylesInjected=!1,t([dt({attribute:!1})],Rt.prototype,"hass",void 0),t([ht()],Rt.prototype,"_config",void 0),t([ht()],Rt.prototype,"_events",void 0),t([ht()],Rt.prototype,"_selectedEvent",void 0),t([ht()],Rt.prototype,"_loading",void 0),t([ht()],Rt.prototype,"_error",void 0),t([ht()],Rt.prototype,"_hoveredEventId",void 0),t([ht()],Rt.prototype,"_liveViewError",void 0),Rt=Et=t([(t=>(e,i)=>{void 0!==i?i.addInitializer(()=>{customElements.define(t,e)}):customElements.define(t,e)})("frigate-events-card")],Rt),window.customCards=window.customCards||[],window.customCards.push({type:"frigate-events-card",name:"Frigate Events Card",description:"A simple card for displaying recent Frigate detection events",preview:!0}),console.info(`%c FRIGATE-EVENTS-CARD v${Tt} %c Loaded `,"color: white; background: #3b82f6; font-weight: bold;","color: #3b82f6; background: white;");export{Rt as FrigateEventsCard};
