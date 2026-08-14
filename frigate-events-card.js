function e(e,t,i,n){var s,o=arguments.length,r=o<3?t:null===n?n=Object.getOwnPropertyDescriptor(t,i):n;if("object"==typeof Reflect&&"function"==typeof Reflect.decorate)r=Reflect.decorate(e,t,i,n);else for(var a=e.length-1;a>=0;a--)(s=e[a])&&(r=(o<3?s(r):o>3?s(t,i,r):s(t,i))||r);return o>3&&r&&Object.defineProperty(t,i,r),r}"function"==typeof SuppressedError&&SuppressedError;const t=globalThis,i=t.ShadowRoot&&(void 0===t.ShadyCSS||t.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,n=Symbol(),s=new WeakMap;let o=class{constructor(e,t,i){if(this._$cssResult$=!0,i!==n)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this.t=t}get styleSheet(){let e=this.o;const t=this.t;if(i&&void 0===e){const i=void 0!==t&&1===t.length;i&&(e=s.get(t)),void 0===e&&((this.o=e=new CSSStyleSheet).replaceSync(this.cssText),i&&s.set(t,e))}return e}toString(){return this.cssText}};const r=(e,...t)=>{const i=1===e.length?e[0]:t.reduce((t,i,n)=>t+(e=>{if(!0===e._$cssResult$)return e.cssText;if("number"==typeof e)return e;throw Error("Value passed to 'css' function must be a 'css' function result: "+e+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+e[n+1],e[0]);return new o(i,e,n)},a=i?e=>e:e=>e instanceof CSSStyleSheet?(e=>{let t="";for(const i of e.cssRules)t+=i.cssText;return(e=>new o("string"==typeof e?e:e+"",void 0,n))(t)})(e):e,{is:c,defineProperty:l,getOwnPropertyDescriptor:d,getOwnPropertyNames:h,getOwnPropertySymbols:u,getPrototypeOf:p}=Object,_=globalThis,v=_.trustedTypes,g=v?v.emptyScript:"",f=_.reactiveElementPolyfillSupport,m=(e,t)=>e,b={toAttribute(e,t){switch(t){case Boolean:e=e?g:null;break;case Object:case Array:e=null==e?e:JSON.stringify(e)}return e},fromAttribute(e,t){let i=e;switch(t){case Boolean:i=null!==e;break;case Number:i=null===e?null:Number(e);break;case Object:case Array:try{i=JSON.parse(e)}catch(e){i=null}}return i}},y=(e,t)=>!c(e,t),w={attribute:!0,type:String,converter:b,reflect:!1,useDefault:!1,hasChanged:y};Symbol.metadata??=Symbol("metadata"),_.litPropertyMetadata??=new WeakMap;let $=class extends HTMLElement{static addInitializer(e){this._$Ei(),(this.l??=[]).push(e)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(e,t=w){if(t.state&&(t.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(e)&&((t=Object.create(t)).wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){const i=Symbol(),n=this.getPropertyDescriptor(e,i,t);void 0!==n&&l(this.prototype,e,n)}}static getPropertyDescriptor(e,t,i){const{get:n,set:s}=d(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};return{get:n,set(t){const o=n?.call(this);s?.call(this,t),this.requestUpdate(e,o,i)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??w}static _$Ei(){if(this.hasOwnProperty(m("elementProperties")))return;const e=p(this);e.finalize(),void 0!==e.l&&(this.l=[...e.l]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(m("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(m("properties"))){const e=this.properties,t=[...h(e),...u(e)];for(const i of t)this.createProperty(i,e[i])}const e=this[Symbol.metadata];if(null!==e){const t=litPropertyMetadata.get(e);if(void 0!==t)for(const[e,i]of t)this.elementProperties.set(e,i)}this._$Eh=new Map;for(const[e,t]of this.elementProperties){const i=this._$Eu(e,t);void 0!==i&&this._$Eh.set(i,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(e){const t=[];if(Array.isArray(e)){const i=new Set(e.flat(1/0).reverse());for(const e of i)t.unshift(a(e))}else void 0!==e&&t.push(a(e));return t}static _$Eu(e,t){const i=t.attribute;return!1===i?void 0:"string"==typeof i?i:"string"==typeof e?e.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(e=>this.enableUpdating=e),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(e=>e(this))}addController(e){(this._$EO??=new Set).add(e),void 0!==this.renderRoot&&this.isConnected&&e.hostConnected?.()}removeController(e){this._$EO?.delete(e)}_$E_(){const e=new Map,t=this.constructor.elementProperties;for(const i of t.keys())this.hasOwnProperty(i)&&(e.set(i,this[i]),delete this[i]);e.size>0&&(this._$Ep=e)}createRenderRoot(){const e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return((e,n)=>{if(i)e.adoptedStyleSheets=n.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(const i of n){const n=document.createElement("style"),s=t.litNonce;void 0!==s&&n.setAttribute("nonce",s),n.textContent=i.cssText,e.appendChild(n)}})(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this._$EO?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this._$EO?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,i){this._$AK(e,i)}_$ET(e,t){const i=this.constructor.elementProperties.get(e),n=this.constructor._$Eu(e,i);if(void 0!==n&&!0===i.reflect){const s=(void 0!==i.converter?.toAttribute?i.converter:b).toAttribute(t,i.type);this._$Em=e,null==s?this.removeAttribute(n):this.setAttribute(n,s),this._$Em=null}}_$AK(e,t){const i=this.constructor,n=i._$Eh.get(e);if(void 0!==n&&this._$Em!==n){const e=i.getPropertyOptions(n),s="function"==typeof e.converter?{fromAttribute:e.converter}:void 0!==e.converter?.fromAttribute?e.converter:b;this._$Em=n;const o=s.fromAttribute(t,e.type);this[n]=o??this._$Ej?.get(n)??o,this._$Em=null}}requestUpdate(e,t,i){if(void 0!==e){const n=this.constructor,s=this[e];if(i??=n.getPropertyOptions(e),!((i.hasChanged??y)(s,t)||i.useDefault&&i.reflect&&s===this._$Ej?.get(e)&&!this.hasAttribute(n._$Eu(e,i))))return;this.C(e,t,i)}!1===this.isUpdatePending&&(this._$ES=this._$EP())}C(e,t,{useDefault:i,reflect:n,wrapped:s},o){i&&!(this._$Ej??=new Map).has(e)&&(this._$Ej.set(e,o??t??this[e]),!0!==s||void 0!==o)||(this._$AL.has(e)||(this.hasUpdated||i||(t=void 0),this._$AL.set(e,t)),!0===n&&this._$Em!==e&&(this._$Eq??=new Set).add(e))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}const e=this.scheduleUpdate();return null!=e&&await e,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??=this.createRenderRoot(),this._$Ep){for(const[e,t]of this._$Ep)this[e]=t;this._$Ep=void 0}const e=this.constructor.elementProperties;if(e.size>0)for(const[t,i]of e){const{wrapped:e}=i,n=this[t];!0!==e||this._$AL.has(t)||void 0===n||this.C(t,void 0,i,n)}}let e=!1;const t=this._$AL;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this._$EO?.forEach(e=>e.hostUpdate?.()),this.update(t)):this._$EM()}catch(t){throw e=!1,this._$EM(),t}e&&this._$AE(t)}willUpdate(e){}_$AE(e){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(e){return!0}update(e){this._$Eq&&=this._$Eq.forEach(e=>this._$ET(e,this[e])),this._$EM()}updated(e){}firstUpdated(e){}};$.elementStyles=[],$.shadowRootOptions={mode:"open"},$[m("elementProperties")]=new Map,$[m("finalized")]=new Map,f?.({ReactiveElement:$}),(_.reactiveElementVersions??=[]).push("2.1.1");const x=globalThis,C=x.trustedTypes,E=C?C.createPolicy("lit-html",{createHTML:e=>e}):void 0,A="$lit$",T=`lit$${Math.random().toFixed(9).slice(2)}$`,S="?"+T,k=`<${S}>`,P=document,R=()=>P.createComment(""),V=e=>null===e||"object"!=typeof e&&"function"!=typeof e,O=Array.isArray,F="[ \t\n\f\r]",M=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,H=/-->/g,U=/>/g,j=RegExp(`>|${F}(?:([^\\s"'>=/]+)(${F}*=${F}*(?:[^ \t\n\f\r"'\`<>=]|("|')|))|$)`,"g"),N=/'/g,I=/"/g,z=/^(?:script|style|textarea|title)$/i,D=(e=>(t,...i)=>({_$litType$:e,strings:t,values:i}))(1),L=Symbol.for("lit-noChange"),W=Symbol.for("lit-nothing"),B=new WeakMap,q=P.createTreeWalker(P,129);function G(e,t){if(!O(e)||!e.hasOwnProperty("raw"))throw Error("invalid template strings array");return void 0!==E?E.createHTML(t):t}const K=(e,t)=>{const i=e.length-1,n=[];let s,o=2===t?"<svg>":3===t?"<math>":"",r=M;for(let t=0;t<i;t++){const i=e[t];let a,c,l=-1,d=0;for(;d<i.length&&(r.lastIndex=d,c=r.exec(i),null!==c);)d=r.lastIndex,r===M?"!--"===c[1]?r=H:void 0!==c[1]?r=U:void 0!==c[2]?(z.test(c[2])&&(s=RegExp("</"+c[2],"g")),r=j):void 0!==c[3]&&(r=j):r===j?">"===c[0]?(r=s??M,l=-1):void 0===c[1]?l=-2:(l=r.lastIndex-c[2].length,a=c[1],r=void 0===c[3]?j:'"'===c[3]?I:N):r===I||r===N?r=j:r===H||r===U?r=M:(r=j,s=void 0);const h=r===j&&e[t+1].startsWith("/>")?" ":"";o+=r===M?i+k:l>=0?(n.push(a),i.slice(0,l)+A+i.slice(l)+T+h):i+T+(-2===l?t:h)}return[G(e,o+(e[i]||"<?>")+(2===t?"</svg>":3===t?"</math>":"")),n]};class J{constructor({strings:e,_$litType$:t},i){let n;this.parts=[];let s=0,o=0;const r=e.length-1,a=this.parts,[c,l]=K(e,t);if(this.el=J.createElement(c,i),q.currentNode=this.el.content,2===t||3===t){const e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;null!==(n=q.nextNode())&&a.length<r;){if(1===n.nodeType){if(n.hasAttributes())for(const e of n.getAttributeNames())if(e.endsWith(A)){const t=l[o++],i=n.getAttribute(e).split(T),r=/([.?@])?(.*)/.exec(t);a.push({type:1,index:s,name:r[2],strings:i,ctor:"."===r[1]?ee:"?"===r[1]?te:"@"===r[1]?ie:X}),n.removeAttribute(e)}else e.startsWith(T)&&(a.push({type:6,index:s}),n.removeAttribute(e));if(z.test(n.tagName)){const e=n.textContent.split(T),t=e.length-1;if(t>0){n.textContent=C?C.emptyScript:"";for(let i=0;i<t;i++)n.append(e[i],R()),q.nextNode(),a.push({type:2,index:++s});n.append(e[t],R())}}}else if(8===n.nodeType)if(n.data===S)a.push({type:2,index:s});else{let e=-1;for(;-1!==(e=n.data.indexOf(T,e+1));)a.push({type:7,index:s}),e+=T.length-1}s++}}static createElement(e,t){const i=P.createElement("template");return i.innerHTML=e,i}}function Y(e,t,i=e,n){if(t===L)return t;let s=void 0!==n?i._$Co?.[n]:i._$Cl;const o=V(t)?void 0:t._$litDirective$;return s?.constructor!==o&&(s?._$AO?.(!1),void 0===o?s=void 0:(s=new o(e),s._$AT(e,i,n)),void 0!==n?(i._$Co??=[])[n]=s:i._$Cl=s),void 0!==s&&(t=Y(e,s._$AS(e,t.values),s,n)),t}class Z{constructor(e,t){this._$AV=[],this._$AN=void 0,this._$AD=e,this._$AM=t}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(e){const{el:{content:t},parts:i}=this._$AD,n=(e?.creationScope??P).importNode(t,!0);q.currentNode=n;let s=q.nextNode(),o=0,r=0,a=i[0];for(;void 0!==a;){if(o===a.index){let t;2===a.type?t=new Q(s,s.nextSibling,this,e):1===a.type?t=new a.ctor(s,a.name,a.strings,this,e):6===a.type&&(t=new ne(s,this,e)),this._$AV.push(t),a=i[++r]}o!==a?.index&&(s=q.nextNode(),o++)}return q.currentNode=P,n}p(e){let t=0;for(const i of this._$AV)void 0!==i&&(void 0!==i.strings?(i._$AI(e,i,t),t+=i.strings.length-2):i._$AI(e[t])),t++}}class Q{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(e,t,i,n){this.type=2,this._$AH=W,this._$AN=void 0,this._$AA=e,this._$AB=t,this._$AM=i,this.options=n,this._$Cv=n?.isConnected??!0}get parentNode(){let e=this._$AA.parentNode;const t=this._$AM;return void 0!==t&&11===e?.nodeType&&(e=t.parentNode),e}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(e,t=this){e=Y(this,e,t),V(e)?e===W||null==e||""===e?(this._$AH!==W&&this._$AR(),this._$AH=W):e!==this._$AH&&e!==L&&this._(e):void 0!==e._$litType$?this.$(e):void 0!==e.nodeType?this.T(e):(e=>O(e)||"function"==typeof e?.[Symbol.iterator])(e)?this.k(e):this._(e)}O(e){return this._$AA.parentNode.insertBefore(e,this._$AB)}T(e){this._$AH!==e&&(this._$AR(),this._$AH=this.O(e))}_(e){this._$AH!==W&&V(this._$AH)?this._$AA.nextSibling.data=e:this.T(P.createTextNode(e)),this._$AH=e}$(e){const{values:t,_$litType$:i}=e,n="number"==typeof i?this._$AC(e):(void 0===i.el&&(i.el=J.createElement(G(i.h,i.h[0]),this.options)),i);if(this._$AH?._$AD===n)this._$AH.p(t);else{const e=new Z(n,this),i=e.u(this.options);e.p(t),this.T(i),this._$AH=e}}_$AC(e){let t=B.get(e.strings);return void 0===t&&B.set(e.strings,t=new J(e)),t}k(e){O(this._$AH)||(this._$AH=[],this._$AR());const t=this._$AH;let i,n=0;for(const s of e)n===t.length?t.push(i=new Q(this.O(R()),this.O(R()),this,this.options)):i=t[n],i._$AI(s),n++;n<t.length&&(this._$AR(i&&i._$AB.nextSibling,n),t.length=n)}_$AR(e=this._$AA.nextSibling,t){for(this._$AP?.(!1,!0,t);e!==this._$AB;){const t=e.nextSibling;e.remove(),e=t}}setConnected(e){void 0===this._$AM&&(this._$Cv=e,this._$AP?.(e))}}class X{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(e,t,i,n,s){this.type=1,this._$AH=W,this._$AN=void 0,this.element=e,this.name=t,this._$AM=n,this.options=s,i.length>2||""!==i[0]||""!==i[1]?(this._$AH=Array(i.length-1).fill(new String),this.strings=i):this._$AH=W}_$AI(e,t=this,i,n){const s=this.strings;let o=!1;if(void 0===s)e=Y(this,e,t,0),o=!V(e)||e!==this._$AH&&e!==L,o&&(this._$AH=e);else{const n=e;let r,a;for(e=s[0],r=0;r<s.length-1;r++)a=Y(this,n[i+r],t,r),a===L&&(a=this._$AH[r]),o||=!V(a)||a!==this._$AH[r],a===W?e=W:e!==W&&(e+=(a??"")+s[r+1]),this._$AH[r]=a}o&&!n&&this.j(e)}j(e){e===W?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,e??"")}}class ee extends X{constructor(){super(...arguments),this.type=3}j(e){this.element[this.name]=e===W?void 0:e}}class te extends X{constructor(){super(...arguments),this.type=4}j(e){this.element.toggleAttribute(this.name,!!e&&e!==W)}}class ie extends X{constructor(e,t,i,n,s){super(e,t,i,n,s),this.type=5}_$AI(e,t=this){if((e=Y(this,e,t,0)??W)===L)return;const i=this._$AH,n=e===W&&i!==W||e.capture!==i.capture||e.once!==i.once||e.passive!==i.passive,s=e!==W&&(i===W||n);n&&this.element.removeEventListener(this.name,this,i),s&&this.element.addEventListener(this.name,this,e),this._$AH=e}handleEvent(e){"function"==typeof this._$AH?this._$AH.call(this.options?.host??this.element,e):this._$AH.handleEvent(e)}}class ne{constructor(e,t,i){this.element=e,this.type=6,this._$AN=void 0,this._$AM=t,this.options=i}get _$AU(){return this._$AM._$AU}_$AI(e){Y(this,e)}}const se=x.litHtmlPolyfillSupport;se?.(J,Q),(x.litHtmlVersions??=[]).push("3.3.1");const oe=globalThis;let re=class extends ${constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){const e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){const t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this._$Do=((e,t,i)=>{const n=i?.renderBefore??t;let s=n._$litPart$;if(void 0===s){const e=i?.renderBefore??null;n._$litPart$=s=new Q(t.insertBefore(R(),e),e,void 0,i??{})}return s._$AI(e),s})(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return L}};re._$litElement$=!0,re.finalized=!0,oe.litElementHydrateSupport?.({LitElement:re});const ae=oe.litElementPolyfillSupport;ae?.({LitElement:re}),(oe.litElementVersions??=[]).push("4.2.1");const ce={attribute:!0,type:String,converter:b,reflect:!1,hasChanged:y},le=(e=ce,t,i)=>{const{kind:n,metadata:s}=i;let o=globalThis.litPropertyMetadata.get(s);if(void 0===o&&globalThis.litPropertyMetadata.set(s,o=new Map),"setter"===n&&((e=Object.create(e)).wrapped=!0),o.set(i.name,e),"accessor"===n){const{name:n}=i;return{set(i){const s=t.get.call(this);t.set.call(this,i),this.requestUpdate(n,s,e)},init(t){return void 0!==t&&this.C(n,void 0,e,t),t}}}if("setter"===n){const{name:n}=i;return function(i){const s=this[n];t.call(this,i),this.requestUpdate(n,s,e)}}throw Error("Unsupported decorator location: "+n)};function de(e){return(t,i)=>"object"==typeof i?le(e,t,i):((e,t,i)=>{const n=t.hasOwnProperty(i);return t.constructor.createProperty(i,e),n?Object.getOwnPropertyDescriptor(t,i):void 0})(e,t,i)}function he(e){return de({...e,state:!0,attribute:!1})}const ue=2;class pe{constructor(e){}get _$AU(){return this._$AM._$AU}_$AT(e,t,i){this._$Ct=e,this._$AM=t,this._$Ci=i}_$AS(e,t){return this.update(e,t)}update(e,t){return this.render(...t)}}const _e=(e,t)=>{const i=e._$AN;if(void 0===i)return!1;for(const e of i)e._$AO?.(t,!1),_e(e,t);return!0},ve=e=>{let t,i;do{if(void 0===(t=e._$AM))break;i=t._$AN,i.delete(e),e=t}while(0===i?.size)},ge=e=>{for(let t;t=e._$AM;e=t){let i=t._$AN;if(void 0===i)t._$AN=i=new Set;else if(i.has(e))break;i.add(e),be(t)}};function fe(e){void 0!==this._$AN?(ve(this),this._$AM=e,ge(this)):this._$AM=e}function me(e,t=!1,i=0){const n=this._$AH,s=this._$AN;if(void 0!==s&&0!==s.size)if(t)if(Array.isArray(n))for(let e=i;e<n.length;e++)_e(n[e],!1),ve(n[e]);else null!=n&&(_e(n,!1),ve(n));else _e(this,e)}const be=e=>{e.type==ue&&(e._$AP??=me,e._$AQ??=fe)};class ye extends pe{constructor(){super(...arguments),this._$AN=void 0}_$AT(e,t,i){super._$AT(e,t,i),ge(this),this.isConnected=e._$AU}_$AO(e,t=!0){e!==this.isConnected&&(this.isConnected=e,e?this.reconnected?.():this.disconnected?.()),t&&(_e(this,e),ve(this))}setValue(e){if((e=>void 0===e.strings)(this._$Ct))this._$Ct._$AI(e,this);else{const t=[...this._$Ct._$AH];t[this._$Ci]=e,this._$Ct._$AI(t,this,0)}}disconnected(){}reconnected(){}}const we=new WeakMap,$e=(e=>(...t)=>({_$litDirective$:e,values:t}))(class extends ye{render(e){return W}update(e,[t]){const i=t!==this.G;return i&&void 0!==this.G&&this.rt(void 0),(i||this.lt!==this.ct)&&(this.G=t,this.ht=e.options?.host,this.rt(this.ct=e.element)),W}rt(e){if(this.isConnected||(e=void 0),"function"==typeof this.G){const t=this.ht??globalThis;let i=we.get(t);void 0===i&&(i=new WeakMap,we.set(t,i)),void 0!==i.get(this.G)&&this.G.call(this.ht,void 0),i.set(this.G,e),void 0!==e&&this.G.call(this.ht,e)}else this.G.value=e}get lt(){return"function"==typeof this.G?we.get(this.ht??globalThis)?.get(this.G):this.G?.value}disconnected(){this.lt===this.ct&&this.rt(void 0)}reconnected(){this.rt(this.ct)}});function xe(e,t,i){const n=new URLSearchParams;i?.bbox&&n.set("bbox","1"),i?.crop&&n.set("crop","1"),i?.timestamp&&n.set("timestamp","1"),i?.cacheBust&&n.set("h",String(i.cacheBust));const s=n.toString();return`/api/frigate/${encodeURIComponent(e)}/notifications/${encodeURIComponent(t)}/snapshot.jpg${s?"?"+s:""}`}function Ce(e,t){return`/api/frigate/${encodeURIComponent(e)}/notifications/${encodeURIComponent(t)}/clip.mp4`}function Ee(e,t){return`/api/frigate/${encodeURIComponent(e)}/notifications/${encodeURIComponent(t)}/master.m3u8`}var Ae;const Te="2.3.3",Se=[{urls:"stun:stun.l.google.com:19302"},{urls:"stun:stun1.l.google.com:19302"}],ke={frigate_client_id:"frigate",event_count:5,show_label:!0,show_timestamp:!0,show_date:!1,show_accuracy:!1,show_duration:!1,show_description:!0,show_camera_name:!0,show_zones:!0,show_bounding_box:!0,show_modal_navigation:!1,title:"Frigate Events",video:!0,video_on_hover:!0,muted:!0,offset:0,reverse:!1,video_start_skip_seconds:0,video_end_skip_seconds:0,debug:!1,tracking_smoothing:1,scroll:!0,scroll_limit:20,show_scroll_arrows:!1,layout:"row",grid_max_height:"400px"},Pe={person:"🚶",car:"🚗",dog:"🐕",cat:"🐈",bird:"🐦",motorcycle:"🏍️",bicycle:"🚲",truck:"🚚",bus:"🚌",boat:"🚤"};let Re=Ae=class extends re{constructor(){super(...arguments),this._events=[],this._loading=!0,this._hoverVideoCropPositions=new WeakMap,this._liveVideoEl=null,this._handleLiveVideoRef=e=>{const t=e??null;this._liveVideoEl=t,t&&this._remoteStream&&t.srcObject!==this._remoteStream&&(t.srcObject=this._remoteStream,t.play().catch(()=>{}))}}_getDailyResetTimestamp(){if(!this._config?.daily_clear_time)return null;const[e,t]=this._config.daily_clear_time.split(":").map(Number);if(isNaN(e)||isNaN(t))return null;const i=new Date,n=new Date(i);return n.setHours(e,t,0,0),i<n&&n.setDate(n.getDate()-1),n.getTime()/1e3}static getConfigElement(){return null}static getStubConfig(){return{frigate_client_id:"frigate",event_count:5}}setConfig(e){if(!e)throw new Error("Invalid configuration");this._config={...ke,...e}}getCardSize(){return 3}getLayoutOptions(){return{grid_columns:4}}shouldUpdate(e){if(e.has("hass")&&1===e.size){if(void 0!==e.get("hass"))return this.hass&&!this._unsubscribe&&this._subscribeToEvents(),!1}return!0}async firstUpdated(){await this._loadEvents(),await this._subscribeToEvents(),this._setupVisibilityHandler(),this._setupPolling(),this._setupLiveView()}updated(e){if(e.has("hass")&&this.hass&&!this._unsubscribe&&this._subscribeToEvents(),e.has("_config")){const t=e.get("_config");void 0===t||t.live_view===this._config?.live_view&&t.live_view_entity===this._config?.live_view_entity||(this._teardownWebRTC(),this._intersectionObserver?.disconnect(),this._intersectionObserver=void 0,this._liveViewError=void 0,this._setupLiveView())}}connectedCallback(){super.connectedCallback(),this.hasUpdated&&(this._loadEvents(),this._unsubscribe||this._subscribeToEvents(),this._boundVisibilityHandler||this._setupVisibilityHandler(),this._pollInterval||this._setupPolling(),this._intersectionObserver||this._setupLiveView())}disconnectedCallback(){super.disconnectedCallback(),this._cleanup()}_cleanup(){this._unsubscribe&&(this._unsubscribe(),this._unsubscribe=void 0),this._pollInterval&&(clearInterval(this._pollInterval),this._pollInterval=void 0),this._boundVisibilityHandler&&(document.removeEventListener("visibilitychange",this._boundVisibilityHandler),this._boundVisibilityHandler=void 0),this._teardownWebRTC(),this._intersectionGraceTimer&&(clearTimeout(this._intersectionGraceTimer),this._intersectionGraceTimer=void 0),this._intersectionObserver?.disconnect(),this._intersectionObserver=void 0,this._removeModal()}_setupVisibilityHandler(){this._boundVisibilityHandler=()=>{"visible"===document.visibilityState&&(console.debug("Frigate Events Card: Page became visible, refreshing..."),this._loadEvents(),this._unsubscribe&&(this._unsubscribe(),this._unsubscribe=void 0),this._subscribeToEvents())},document.addEventListener("visibilitychange",this._boundVisibilityHandler)}_setupPolling(){this._pollInterval=window.setInterval(()=>{"visible"===document.visibilityState&&this._loadEvents()},1e4)}_setupLiveView(){if(!this._config?.live_view)return;const e=this._config.live_view_entity;return e?e.startsWith("camera.")?(this._intersectionObserver=new IntersectionObserver(e=>{const t=e.some(e=>e.isIntersecting);t?(this._intersectionGraceTimer&&(clearTimeout(this._intersectionGraceTimer),this._intersectionGraceTimer=void 0),this._peerConnection||this._startWebRTC()):this._intersectionGraceTimer||(this._intersectionGraceTimer=window.setTimeout(()=>{this._intersectionGraceTimer=void 0,this._teardownWebRTC()},1e4))},{threshold:.1}),void this._intersectionObserver.observe(this)):(console.warn(`Frigate Events Card: live_view_entity "${e}" must be a camera entity (must start with "camera.").`),void(this._liveViewError=`"${e}" is not a camera entity`)):(console.warn("Frigate Events Card: live_view is enabled but live_view_entity is not set."),void(this._liveViewError="live_view_entity is required when live_view is true"))}async _startWebRTC(){if(!this.hass||!this._config?.live_view_entity)return;const e=this._config.live_view_entity;if(!this._config?.go2rtc_url&&!this.hass.states[e])return console.warn(`Frigate Events Card: Camera entity "${e}" not found in Home Assistant.`),void(this._liveViewError=`Entity "${e}" not found`);if("undefined"==typeof RTCPeerConnection)return console.warn("Frigate Events Card: WebRTC is not supported in this context. HTTPS is required."),void(this._liveViewError="WebRTC unavailable — HTTPS required");if(this._config.go2rtc_url){const t=this._config.go2rtc_stream||e.replace(/^camera\./,"");return void await this._startGo2rtcWebRTC(this._config.go2rtc_url,t)}try{const t=new RTCPeerConnection({iceServers:Se});this._peerConnection=t;const i=new MediaStream;this._remoteStream=i;const n=this._liveVideoEl||this.renderRoot?.querySelector(".live-view-video");n&&(this._liveVideoEl=n,n.srcObject!==i&&(n.srcObject=i,n.play().catch(()=>{}))),t.ontrack=e=>{e.streams[0]?.getTracks().forEach(e=>i.addTrack(e));const t=this._liveVideoEl||this.renderRoot?.querySelector(".live-view-video");t&&(this._liveVideoEl=t,t.srcObject!==i&&(t.srcObject=i),t.play().catch(()=>{}))},t.addTransceiver("video",{direction:"recvonly"});const s=await t.createOffer();await t.setLocalDescription(s);const o=await new Promise(e=>{if("complete"===t.iceGatheringState)return void e(t.localDescription.sdp);t.onicegatheringstatechange=()=>{"complete"===t.iceGatheringState&&e(t.localDescription.sdp)},setTimeout(()=>e(t.localDescription?.sdp||s.sdp),3e3)});this._liveViewUnsub=await this.hass.connection.subscribeMessage(async e=>{if(this._peerConnection&&this._peerConnection===t)switch(e.type){case"session":this._liveViewSessionId=e.session_id;break;case"answer":try{await t.setRemoteDescription(new RTCSessionDescription({type:"answer",sdp:e.answer})),this._liveViewError=void 0}catch(e){console.error("Frigate Events Card: Failed to set WebRTC remote description:",e),this._liveViewError="Stream negotiation failed",this._teardownWebRTC()}break;case"candidate":try{await t.addIceCandidate(new RTCIceCandidate(e.candidate))}catch{}break;case"error":console.warn(`Frigate Events Card: WebRTC stream error (${e.code}): ${e.message}`),this._liveViewError=e.message||"Camera stream unavailable",this._teardownWebRTC()}},{type:"camera/web_rtc_offer",entity_id:e,offer:o}),t.onicecandidate=({candidate:e})=>{e&&this._liveViewSessionId&&this.hass&&this.hass.callWS({type:"camera/web_rtc_candidate",session_id:this._liveViewSessionId,candidate:e.toJSON()}).catch(()=>{})},this._setupWebRTCMonitoring(t)}catch(e){let t=e?.message||("object"==typeof e?JSON.stringify(e):String(e));("unknown_command"===e?.code||t.toLowerCase().includes("unknown command"))&&(t="HA WebRTC protocol (camera/web_rtc_offer) not supported for this entity. Fix WebRTC Camera integration in HA or set go2rtc_url in card config."),console.error("Frigate Events Card: Failed to start WebRTC session:",t),this._liveViewError=`Failed to start: ${t}`,this._teardownWebRTC()}}async _startGo2rtcWebRTC(e,t){try{const i=new RTCPeerConnection({iceServers:Se});this._peerConnection=i;const n=new MediaStream;this._remoteStream=n;const s=this._liveVideoEl||this.renderRoot?.querySelector(".live-view-video");s&&(this._liveVideoEl=s,s.srcObject!==n&&(s.srcObject=n,s.play().catch(()=>{}))),i.ontrack=e=>{e.streams[0]?.getTracks().forEach(e=>n.addTrack(e));const t=this._liveVideoEl||this.renderRoot?.querySelector(".live-view-video");t&&(this._liveVideoEl=t,t.srcObject!==n&&(t.srcObject=n),t.play().catch(()=>{}))},i.addTransceiver("video",{direction:"recvonly"});const o=await i.createOffer();await i.setLocalDescription(o);const r=await new Promise(e=>{if("complete"===i.iceGatheringState)return void e(i.localDescription.sdp);i.onicegatheringstatechange=()=>{"complete"===i.iceGatheringState&&e(i.localDescription.sdp)},setTimeout(()=>e(i.localDescription?.sdp||o.sdp),3e3)}),a=e.replace(/\/+$/,""),c=await fetch(`${a}/api/webrtc?src=${encodeURIComponent(t)}`,{method:"POST",body:r});if(!c.ok)throw new Error(`go2rtc returned HTTP ${c.status}: ${c.statusText}`);const l=await c.text();let d=l;try{const e=JSON.parse(l);if(e.sdp)d=e.sdp;else if(e.error)throw new Error(e.error)}catch(e){if(e.message&&!e.message.includes("JSON")&&!e.message.includes("Unexpected token"))throw e}await i.setRemoteDescription(new RTCSessionDescription({type:"answer",sdp:d})),this._liveViewError=void 0,this._setupWebRTCMonitoring(i)}catch(e){const t=e?.message||String(e);console.error("Frigate Events Card: Failed direct go2rtc WebRTC session:",t),this._liveViewError=`Failed go2rtc stream: ${t}`,this._teardownWebRTC()}}_teardownWebRTC(){this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0),this._peerConnection&&(this._peerConnection.ontrack=null,this._peerConnection.onicecandidate=null,this._peerConnection.onconnectionstatechange=null,this._peerConnection.oniceconnectionstatechange=null,this._peerConnection.onicegatheringstatechange=null,this._peerConnection.close(),this._peerConnection=void 0),this._liveViewUnsub&&(this._liveViewUnsub(),this._liveViewUnsub=void 0),this._liveViewSessionId&&this.hass&&(this.hass.callWS({type:"camera/close_webrtc_session",session_id:this._liveViewSessionId}).catch(()=>{}),this._liveViewSessionId=void 0),this._liveVideoEl&&(this._liveVideoEl.srcObject=null),this._remoteStream&&(this._remoteStream.getTracks().forEach(e=>e.stop()),this._remoteStream=void 0)}_handleLiveViewClick(e){const t=e.currentTarget,i=this._liveVideoEl||t.querySelector("video"),n=document;if(!!(n.fullscreenElement||n.webkitFullscreenElement||n.mozFullScreenElement||n.msFullscreenElement))document.exitFullscreen?document.exitFullscreen().catch(()=>{}):n.webkitExitFullscreen?n.webkitExitFullscreen():n.mozCancelFullScreen?n.mozCancelFullScreen():n.msExitFullscreen&&n.msExitFullscreen();else if(i){const e=i;e.requestFullscreen?e.requestFullscreen().catch(()=>{e.webkitEnterFullscreen?e.webkitEnterFullscreen():t&&t.requestFullscreen&&t.requestFullscreen().catch(()=>{})}):e.webkitEnterFullscreen?e.webkitEnterFullscreen():e.webkitRequestFullscreen?e.webkitRequestFullscreen():t&&t.requestFullscreen&&t.requestFullscreen().catch(()=>{})}else t&&t.requestFullscreen&&t.requestFullscreen().catch(()=>{})}_setupWebRTCMonitoring(e){const t=()=>{const t=e.connectionState,i=e.iceConnectionState;console.debug(`Frigate Events Card: WebRTC state → connection: ${t}, ice: ${i}`),"connected"===t||"connected"===i||"completed"===i?this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0):"failed"===t||"failed"===i?(this._disconnectTimer&&(clearTimeout(this._disconnectTimer),this._disconnectTimer=void 0),console.warn("Frigate Events Card: WebRTC connection failed; auto-reconnecting in 5s."),this._teardownWebRTC(),window.setTimeout(()=>{this._intersectionObserver&&!this._peerConnection&&this._startWebRTC()},5e3)):"disconnected"!==t&&"disconnected"!==i||this._disconnectTimer||(console.warn("Frigate Events Card: WebRTC stream disconnected; starting 10s self-healing timer..."),this._disconnectTimer=window.setTimeout(()=>{this._disconnectTimer=void 0,this._peerConnection!==e||"disconnected"!==e.connectionState&&"disconnected"!==e.iceConnectionState||(console.warn("Frigate Events Card: WebRTC stream remained disconnected for 10s. Triggering self-healing restart."),this._teardownWebRTC(),this._startWebRTC())},1e4))};e.onconnectionstatechange=t,e.oniceconnectionstatechange=t}async _loadEvents(){if(this.hass&&this._config){this._error=void 0;try{const e=!!this._config.scroll,t=this._config.event_count||5,i=this._config.scroll_limit||20,n=(e?i:t)+(this._config.offset||0),s=await async function(e,t){const i=await e.callWS({type:"frigate/events/get",...t});return JSON.parse(i)}(this.hass,{instance_id:this._config.frigate_client_id,cameras:this._config.cameras,labels:this._config.labels,zones:this._config.zones,limit:n,has_snapshot:!0});this._events=s.sort((e,t)=>(t.start_time||0)-(e.start_time||0))}catch(e){console.error("Failed to load Frigate events:",e);const t=e?.message||("object"==typeof e?JSON.stringify(e):String(e));this._error=`Failed to load events: ${t}`}finally{this._loading=!1}}}async _subscribeToEvents(){if(this.hass&&this._config&&!this._unsubscribe)try{this._unsubscribe=await async function(e,t,i){const n=await e.connection.subscribeMessage(e=>{try{const t=JSON.parse(e);i(t)}catch(e){console.warn("Failed to parse Frigate event:",e)}},{type:"frigate/events/subscribe",instance_id:t});return n}(this.hass,this._config.frigate_client_id||"frigate",e=>{this._matchesFilters(e)&&("new"!==e.type&&"end"!==e.type||this._loadEvents())})}catch(e){console.warn("Failed to subscribe to Frigate events:",e)}}_matchesFilters(e){const t=this._config;if(!t)return!0;const i=e.after;if(t.cameras?.length&&!t.cameras.includes(i.camera))return!1;if(t.labels?.length&&!t.labels.includes(i.label))return!1;if(t.zones?.length){const e=t.zones.some(e=>i.current_zones.includes(e));if(!e)return!1}return!0}_handleRefresh(){this._loadEvents()}_handleEventClick(e){this._selectedEvent=e,this._showModal()}_handleModalClose(){this._selectedEvent=void 0,this._removeModal()}_injectModalStyles(){if(Ae._stylesInjected)return;const e="frigate-events-card-modal-styles";if(document.getElementById(e))return void(Ae._stylesInjected=!0);const t=document.createElement("style");t.id=e,t.textContent="\n      .frigate-events-modal {\n        position: fixed;\n        top: 0;\n        left: 0;\n        width: 100%;\n        height: 100%;\n        background: rgba(0, 0, 0, 0.85);\n        z-index: 9999;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        padding: 20px;\n        box-sizing: border-box;\n        backdrop-filter: blur(5px);\n        animation: frigate-modal-fade-in 0.2s forwards;\n      }\n\n      @keyframes frigate-modal-fade-in {\n        from { opacity: 0; }\n        to { opacity: 1; }\n      }\n\n      .frigate-events-modal-content {\n        position: relative;\n        width: fit-content;\n        min-width: 450px;\n        max-width: 90%;\n        max-height: 90%;\n        background: var(--card-background-color, #1c1c1c);\n        border-radius: 12px;\n        overflow: hidden;\n        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);\n        display: flex;\n        flex-direction: column;\n        animation: frigate-modal-slide-up 0.2s forwards;\n      }\n\n      @keyframes frigate-modal-slide-up {\n        from { transform: translateY(20px); opacity: 0; }\n        to { transform: translateY(0); opacity: 1; }\n      }\n\n      .frigate-events-modal-image-container {\n        position: relative;\n        display: flex;\n        justify-content: center;\n        background: #1c1c1c;\n      }\n\n      .frigate-events-modal-image-container img,\n      .frigate-events-modal-image-container video {\n        max-width: 100%;\n        max-height: 55vh;\n        width: auto;\n        height: auto;\n        display: block;\n        background-color: #1c1c1c;\n      }\n\n      .frigate-events-modal-close {\n        position: absolute;\n        top: 10px;\n        right: 10px;\n        background: rgba(0, 0, 0, 0.5);\n        color: white;\n        width: 32px;\n        height: 32px;\n        border-radius: 50%;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 18px;\n        cursor: pointer;\n        transition: background 0.2s;\n        backdrop-filter: blur(4px);\n        border: none;\n        font-family: inherit;\n      }\n\n      .frigate-events-modal-close:hover {\n        background: rgba(0, 0, 0, 0.8);\n      }\n\n      .frigate-events-modal-nav {\n        position: absolute;\n        top: 50%;\n        transform: translateY(-50%);\n        background: rgba(0, 0, 0, 0.5);\n        color: white;\n        width: 40px;\n        height: 40px;\n        border-radius: 50%;\n        display: flex;\n        align-items: center;\n        justify-content: center;\n        font-size: 20px;\n        cursor: pointer;\n        transition: background 0.2s, opacity 0.2s;\n        backdrop-filter: blur(4px);\n        border: none;\n        font-family: inherit;\n        z-index: 10;\n        user-select: none;\n        line-height: 1;\n      }\n\n      .frigate-events-modal-nav svg {\n        width: 22px;\n        height: 22px;\n        fill: currentColor;\n        display: block;\n      }\n\n      .frigate-events-modal-nav:hover {\n        background: rgba(0, 0, 0, 0.8);\n      }\n\n      .frigate-events-modal-nav.prev {\n        left: 10px;\n      }\n\n      .frigate-events-modal-nav.next {\n        right: 10px;\n      }\n\n      .frigate-events-modal-info {\n        padding: 16px;\n        background: var(--card-background-color, #1c1c1c);\n        display: flex;\n        flex-direction: column;\n        gap: 12px;\n        width: 0;\n        min-width: 100%;\n        box-sizing: border-box;\n      }\n\n      .frigate-events-modal-info-top {\n        display: flex;\n        justify-content: space-between;\n        align-items: flex-start;\n        gap: 16px;\n        width: 100%;\n      }\n\n      .frigate-events-modal-info-left {\n        display: flex;\n        flex-direction: column;\n        gap: 4px;\n        min-width: 0;\n        flex: 1;\n      }\n\n      .frigate-events-modal-info-center {\n        display: flex;\n        flex: 2;\n        align-items: center;\n        justify-content: center;\n        text-align: center;\n        min-width: 0;\n        padding: 0 16px;\n        align-self: center;\n      }\n\n      .frigate-events-modal-info-right {\n        display: flex;\n        flex-direction: column;\n        align-items: flex-end;\n        gap: 4px;\n        flex: 1;\n        flex-shrink: 0;\n        text-align: right;\n      }\n\n      .frigate-events-modal-label {\n        font-size: 20px;\n        font-weight: 600;\n        color: var(--primary-text-color, #fff);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-camera {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-time {\n        font-size: 20px;\n        font-weight: 500;\n        color: var(--primary-text-color, #fff);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-zones {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-duration {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-score {\n        font-size: 13px;\n        color: var(--secondary-text-color, #aaa);\n        line-height: 1.2;\n      }\n\n      .frigate-events-modal-description-row {\n        border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.15));\n        padding-top: 12px;\n        margin-top: 4px;\n        width: 100%;\n        max-height: 90px;\n        overflow-y: auto;\n      }\n\n      .frigate-events-modal-description-row::-webkit-scrollbar {\n        width: 6px;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-track {\n        background: transparent;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-thumb {\n        background-color: rgba(255, 255, 255, 0.15);\n        border-radius: 3px;\n      }\n      .frigate-events-modal-description-row::-webkit-scrollbar-thumb:hover {\n        background-color: rgba(255, 255, 255, 0.35);\n      }\n\n      .frigate-events-modal-description {\n        font-size: 13px;\n        line-height: 1.5;\n        color: var(--primary-text-color, #e0e0e0);\n        font-style: italic;\n        white-space: pre-wrap;\n      }\n    ",document.head.appendChild(t),Ae._stylesInjected=!0}_getConfigValueForEvent(e,t,i){if(null==e)return i;if("number"==typeof e)return e;const n=t.label,s=t.zones||[];for(const t of s){const i=`${n}:${t}`;if(void 0!==e[i])return e[i];const s=`${t}:${n}`;if(void 0!==e[s])return e[s]}if(void 0!==e[n])return e[n];for(const t of s)if(void 0!==e[t])return e[t];return void 0!==e.default?e.default:i}_getVideoTimeParam(e){const t=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,e,0);return t>0?`#t=${t}`:""}_getEventsToShow(){if(!this._config)return[];const e=!!this._config.scroll,t=this._config.event_count||5,i=this._config.scroll_limit||20,n=e?i:t;let s=this._events;const o=this._getDailyResetTimestamp();null!==o&&(s=this._events.filter(e=>(e.start_time||0)>o));const r=this._config.offset||0,a=s.slice(r,r+n);return this._config.reverse?[...a].reverse():a}_navigateToEvent(e){if(!this._selectedEvent)return;const t=this._getEventsToShow(),i=t.findIndex(e=>e.id===this._selectedEvent?.id);if(-1===i)return;let n=i;"next"===e?n=i+1:"prev"===e&&(n=i-1),n>=0&&n<t.length&&(this._selectedEvent=t[n],this._showModal())}_handleKeyDown(e){this._selectedEvent&&("ArrowRight"===e.key?this._navigateToEvent("next"):"ArrowLeft"===e.key?this._navigateToEvent("prev"):"Escape"===e.key&&this._handleModalClose())}_showModal(){if(!this._selectedEvent)return;console.log("Frigate Events Card: event clicked =",this._selectedEvent),this._injectModalStyles();const e=!!this._modalContainer;e&&this._boundKeyDownHandler&&(window.removeEventListener("keydown",this._boundKeyDownHandler),this._boundKeyDownHandler=void 0);const t=this._selectedEvent,i=this._config?.frigate_client_id||"frigate",n=xe(i,t.id,{bbox:!1!==this._config?.show_bounding_box,timestamp:!0,cacheBust:t.end_time||void 0}),s=this._formatDuration(t.start_time,t.end_time),o=this._formatZones(t.zones);e||(this._modalContainer=document.createElement("div"),this._modalContainer.className="frigate-events-modal",this._modalContainer.addEventListener("click",()=>this._handleModalClose()));const r=!!this._config?.video,a=this._getVideoTimeParam(t),c=Ce(i,t.id)+a,l=Ee(i,t.id)+a,d=t.data?.top_score??t.top_score??t.data?.score,h=null!=d?`${Math.round(100*d)}%`:"",u=this._formatTime(t.start_time),p=`${this._config?.show_date?`${this._formatDate(t.start_time)} · `:""}${u}`,_=!!this._config?.show_duration,v=!!this._config?.show_accuracy,g=!1!==this._config?.show_description,f=!1!==this._config?.show_camera_name,m=!1!==this._config?.show_zones,b=this._getEventsToShow(),y=b.findIndex(e=>e.id===t.id),w=y>0,$=-1!==y&&y<b.length-1,x=!!this._config?.show_modal_navigation,C=x&&w?'<button class="frigate-events-modal-nav prev" title="Previous event">\n           <svg viewBox="0 0 24 24">\n             <path d="M15,6L9,12L15,18Z" fill="currentColor"/>\n           </svg>\n         </button>':"",E=x&&$?'<button class="frigate-events-modal-nav next" title="Next event">\n           <svg viewBox="0 0 24 24">\n             <path d="M9,6L15,12L9,18Z" fill="currentColor"/>\n           </svg>\n         </button>':"",A=this._modalContainer;if(!A)return;A.innerHTML=`\n      <div class="frigate-events-modal-content">\n        <div class="frigate-events-modal-image-container">\n          ${C}\n          ${r?`<video autoplay ${this._config?.muted?"muted":""} controls playsinline>\n                 <source src="${c}" type="video/mp4">\n                 <source src="${l}" type="application/x-mpegURL">\n               </video>`:`<img src="${n}" alt="${t.label}" />`}          ${E}\n          <button class="frigate-events-modal-close">x</button>\n        </div>\n        <div class="frigate-events-modal-info">\n          <div class="frigate-events-modal-info-top">\n            <div class="frigate-events-modal-info-left">\n              <div class="frigate-events-modal-label">\n                ${this._capitalize(t.label)}\n              </div>\n              ${f?`<div class="frigate-events-modal-camera">\n                     ${this._formatCameraName(t.camera)}\n                   </div>`:""}\n              ${v&&h?`<div class="frigate-events-modal-score">${h}</div>`:""}\n            </div>\n            \n            <div class="frigate-events-modal-info-right">\n              <div class="frigate-events-modal-time">${p}</div>\n              ${m&&o?`<div class="frigate-events-modal-zones">${o}</div>`:""}\n              ${_?`<div class="frigate-events-modal-duration">${s}</div>`:""}\n            </div>\n          </div>\n          ${g&&(t.description||t.data?.description)?`<div class="frigate-events-modal-description-row">\n                 <div class="frigate-events-modal-description">${t.description||t.data?.description}</div>\n               </div>`:""}\n        </div>\n      </div>\n    `;const T=A.querySelector("video");T&&(T.muted=!1!==this._config?.muted);const S=A.querySelector(".frigate-events-modal-content");S?.addEventListener("click",e=>e.stopPropagation());const k=A.querySelector(".frigate-events-modal-close");if(k?.addEventListener("click",()=>this._handleModalClose()),x&&w){const e=A.querySelector(".frigate-events-modal-nav.prev");e?.addEventListener("click",e=>{e.stopPropagation(),this._navigateToEvent("prev")})}if(x&&$){const e=A.querySelector(".frigate-events-modal-nav.next");e?.addEventListener("click",e=>{e.stopPropagation(),this._navigateToEvent("next")})}this._boundKeyDownHandler=e=>this._handleKeyDown(e),window.addEventListener("keydown",this._boundKeyDownHandler),e||document.body.appendChild(A)}_removeModal(){this._modalContainer&&this._modalContainer.parentNode&&(this._modalContainer.parentNode.removeChild(this._modalContainer),this._modalContainer=void 0),this._boundKeyDownHandler&&(window.removeEventListener("keydown",this._boundKeyDownHandler),this._boundKeyDownHandler=void 0)}_formatTime(e){return new Date(1e3*e).toLocaleTimeString(void 0,{hour:"numeric",minute:"2-digit",second:"2-digit"}).toUpperCase()}_formatDate(e){return new Date(1e3*e).toLocaleDateString(void 0,{month:"short",day:"numeric",year:"numeric"})}_formatDuration(e,t){if(!t)return"Ongoing";const i=Math.round(t-e);if(i<60)return`${i}s`;const n=Math.floor(i/60),s=i%60;return s>0?`${n}m ${s}s`:`${n}m`}_formatZones(e){return e&&0!==e.length?e.map(e=>e.replace(/_/g," ").replace(/\b\w/g,e=>e.toUpperCase())).join(", "):""}_isValidBoundingBox(e){return Array.isArray(e)&&4===e.length&&e.every(e=>"number"==typeof e&&Number.isFinite(e))&&(e[2]>e[0]&&e[3]>e[1]||e[2]>0&&e[3]>0)}_isNormalizedBox(e){return e.every(e=>e>=0&&e<=1)}_getEventBoundingBoxCandidate(e){return[{source:"data.snapshot.box",box:e.data?.snapshot?.box},{source:"data.box",box:e.data?.box},{source:"box",box:e.box},{source:"data.snapshot.region",box:e.data?.snapshot?.region},{source:"data.region",box:e.data?.region},{source:"region",box:e.region}].find(e=>this._isValidBoundingBox(e.box))}_getEventBoundingBox(e){return this._getEventBoundingBoxCandidate(e)?.box}_getBoxCenter(e,t,i){const[n,s,o,r]=e;if(this._isNormalizedBox(e)){const e=n+o/2>1||s+r/2>1;return{x:(e?n:n+o/2)*t,y:(e?s:s+r/2)*i}}return{x:(n+o)/2,y:(s+r)/2}}_getValidPathData(e){return(e.data?.path_data||[]).filter(e=>Array.isArray(e)&&2===e.length&&Array.isArray(e[0])&&2===e[0].length&&e[0].every(e=>"number"==typeof e&&Number.isFinite(e))&&"number"==typeof e[1]&&Number.isFinite(e[1]))}_getInterpolatedPathPoint(e,t,i){const n=this._getValidPathData(e);if(!n.length)return;const s=n[0],o=n[n.length-1];if(i<=s[1])return{x:s[0][0]*t.videoWidth,y:s[0][1]*t.videoHeight};if(i>=o[1])return{x:o[0][0]*t.videoWidth,y:o[0][1]*t.videoHeight};for(let e=1;e<n.length;e++){const s=n[e-1],o=n[e];if(i>o[1])continue;const r=o[1]-s[1],a=r>0?(i-s[1])/r:0,c=a*a*(3-2*a),l=s[0][0]+(o[0][0]-s[0][0])*c,d=s[0][1]+(o[0][1]-s[0][1])*c;return{x:l*t.videoWidth,y:d*t.videoHeight}}return{x:o[0][0]*t.videoWidth,y:o[0][1]*t.videoHeight}}_getSmoothedPathPoint(e,t){if(!e.start_time)return;const i=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,e,0),n=this._getTrackingTimeOffset(e),s=e.start_time+(t.currentTime-i)-n,o=this._config?.tracking_smoothing??1;if(o<=.01)return this._getInterpolatedPathPoint(e,t,s);const r=2*o,a=r/2;let c=0,l=0,d=0;for(let i=0;i<=10;i++){const n=s-a+r*(i/10),o=this._getInterpolatedPathPoint(e,t,n);o&&(c+=o.x,l+=o.y,d++)}return 0!==d?{x:c/d,y:l/d}:void 0}_calculateObjectPositionPercentForPoint(e,t,i){const n=t.videoWidth,s=t.videoHeight,o=t.clientWidth,r=t.clientHeight;if(!(n&&s&&o&&r))return;const a=Math.max(o/n,r/s),c=s*a,l=e=>Math.min(100,Math.max(0,e)),d=(e,t,i,n)=>{if(t<=e+.5)return 50;const s=t-e,o=.2*e,r=i*a;if(void 0!==n){const t=(r-e+o)/s*100,i=(r-o)/s*100;return n>=t&&n<=i?n:l(Math.min(Math.max(n,t),i))}return l((r-e/2)/s*100)};return{x:d(o,n*a,e.x,i?.x),y:d(r,c,e.y,i?.y)}}_formatObjectPosition(e){return`${e.x.toFixed(2)}% ${e.y.toFixed(2)}%`}_calculateObjectPositionPercent(e,t,i){if(t.videoWidth&&t.videoHeight)return this._calculateObjectPositionPercentForPoint(this._getBoxCenter(e,t.videoWidth,t.videoHeight),t,i)}_getTrackingTimeOffset(e){return this._getConfigValueForEvent(this._config?.tracking_pan_delay,e,0)/1e3}_updateHoverVideoObjectPosition(e,t){const i=this._getSmoothedPathPoint(t,e),n=this._getEventBoundingBoxCandidate(t),s=this._hoverVideoCropPositions.get(e),o=this._getTrackingTimeOffset(t),r=i?this._calculateObjectPositionPercentForPoint(i,e,s):n?this._calculateObjectPositionPercent(n.box,e,s):void 0;if(!r)return this._hoverVideoCropPositions.delete(e),e.style.objectPosition="50% 50%","center";const a=s?{x:s.x+.15*(r.x-s.x),y:s.y+.15*(r.y-s.y)}:r;this._hoverVideoCropPositions.set(e,a),e.style.objectPosition=this._formatObjectPosition(a);let c=i?"data.path_data":n?.source??"center";if(0!==o&&(c+=` (${o>0?"+":""}${o}s delay)`),this._config?.debug&&i){const i=this._getValidPathData(t);if(i.length){const n=i[0][1]-(t.start_time||0),s=i[i.length-1][1]-(t.start_time||0),r=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,t,0),a=e.currentTime-r-o;c+=` [V:${e.currentTime.toFixed(1)}s, P:${a.toFixed(1)}s, Range:${n.toFixed(1)}-${s.toFixed(1)}s]`}}return c}_startHoverVideoTracking(e,t){const i=()=>{e.isConnected&&this._hoveredEventId===t.id&&(this._updateHoverVideoObjectPosition(e,t),requestAnimationFrame(i))};requestAnimationFrame(i)}_handleHoverVideoMetadata(e,t){const i=e.currentTarget;if(!(i instanceof HTMLVideoElement))return;const n=this._updateHoverVideoObjectPosition(i,t);if(this._config?.debug){const e=this._getEventBoundingBoxCandidate(t);console.debug("Frigate Events Card: hover crop debug",{eventId:t.id,camera:t.camera,label:t.label,cropSource:n,chosenBoxSource:e?.source??null,chosenBox:e?.box??null,pathDataPoints:this._getValidPathData(t).length,candidateBoxes:{dataSnapshotBox:t.data?.snapshot?.box,dataBox:t.data?.box,box:t.box,dataSnapshotRegion:t.data?.snapshot?.region,dataRegion:t.data?.region,region:t.region},objectPosition:i.style.objectPosition,videoSize:{width:i.videoWidth,height:i.videoHeight},tileSize:{width:i.clientWidth,height:i.clientHeight},event:t})}this._startHoverVideoTracking(i,t)}_handleVideoTimeUpdate(e,t){const i=e.currentTarget,n=this._getConfigValueForEvent(this._config?.video_start_skip_seconds||this._config?.video_start_padding,t,0),s=this._getConfigValueForEvent(this._config?.video_end_skip_seconds,t,0);if(i.duration&&isFinite(i.duration))if(s>0){const e=Math.max(n,i.duration-s);i.currentTime>=e-.1&&(i.currentTime=n,i.play().catch(()=>{}))}else n>0&&i.currentTime<n&&i.currentTime<1&&(i.currentTime=n)}_getLabelIcon(e){return Pe[e.toLowerCase()]||"📷"}render(){if(!this._config)return D`<ha-card>No configuration</ha-card>`;const e="grid"===this._config.layout,t=!e&&!!this._config.scroll,i=t&&!!this._config.show_scroll_arrows,n=this._config.event_count||5,s=this._config.scroll_limit||20,o=this._config.scroll?s:n;let r=this._events;const a=this._getDailyResetTimestamp();null!==a&&(r=this._events.filter(e=>(e.start_time||0)>a));const c=this._config.offset||0,l=r.slice(c,c+o);let d=Math.max(0,(t?n:o)-l.length);if(e&&this._config.grid_columns&&d>0){const e=l.length+d;d=Math.ceil(e/this._config.grid_columns)*this._config.grid_columns-l.length}let h=[...l.map(e=>this._renderEvent(e)),...Array(d).fill(0).map(()=>D`<div class="placeholder" title="No events found. Check that snapshots: enabled: true in Frigate."></div>`)];this._config.reverse&&h.reverse();const u=["events",e?"grid":"",e&&this._config.scroll?"scrollable-y":"",!e&&this._config.scroll?"scrollable":""].filter(Boolean).join(" "),p=this._config.grid_columns,_=p?`repeat(${p}, 1fr)`:"repeat(auto-fill, minmax(120px, 1fr))",v=this._config.grid_max_height||"400px",g=e?`grid-template-columns: ${_}; --grid-max-height: ${v};`:`--visible-count: ${n}; --event-count: ${o};`;return D`
      <ha-card>
        <div class="content">
          ${this._config.debug?D`
            <div class="debug-banner">
              <span>v${Te} • Instance: ${this._config.frigate_client_id||"frigate"} • Events: ${this._events.length}</span>
              ${this._loading||this._error||0!==this._events.length?"":D`
                <div class="debug-warning">0 events returned. Verify Frigate has <code>snapshots: enabled: true</code>.</div>
              `}
            </div>
          `:""}
          ${this._config.live_view?this._renderLiveView():""}
          ${this._loading?D`<div class="loading"></div>`:this._error?D`
                <div class="events-error">
                  <span>⚠ ${this._error}</span>
                  <span class="events-error-detail">Check your Frigate integration connection and instance ID.</span>
                </div>
              `:D`
                  <div class="events-container">
                    ${i?D`
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
                    <div class="${u}" style="${g}">
                      ${h}
                    </div>
                  </div>
                `}
        </div>
      </ha-card>
    `}_renderLiveView(){const e=this._config?.live_view_aspect_ratio||"16 / 9";return this._liveViewError?D`
        <div class="live-view-container" style="aspect-ratio: ${e};">
          <div class="live-view-error">
            <span>⚠ Live feed unavailable</span>
            <span class="live-view-error-detail">${this._liveViewError}</span>
          </div>
        </div>
      `:D`
      <div
        class="live-view-container"
        style="aspect-ratio: ${e};"
        @click=${e=>this._handleLiveViewClick(e)}
        title="Click for fullscreen"
      >
        <video
          class="live-view-video"
          autoplay
          muted
          playsinline
          webkit-playsinline
          disablepictureinpicture
          disableremoteplayback
          poster="data:image/png;base64,iVBORw0KGgoAAAANSU5EUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
          ${$e(this._handleLiveVideoRef)}
        ></video>
      </div>
    `}_renderEvent(e){const t=this._config?.frigate_client_id||"frigate",i=xe(t,e.id,{bbox:!1!==this._config?.show_bounding_box,crop:!0,cacheBust:e.end_time||void 0}),n=this._hoveredEventId===e.id,s=!!this._config?.video_on_hover,o=this._getVideoTimeParam(e),r=Ce(t,e.id)+o,a=Ee(t,e.id)+o,c=function(e,t){return`/api/frigate/${encodeURIComponent(e)}/thumbnail/${encodeURIComponent(t)}`}(t,e.id);return D`
      <div class="event"
        @click=${()=>this._handleEventClick(e)}
        @mouseenter=${()=>{s&&(this._hoveredEventId=e.id)}}
        @mouseleave=${()=>{s&&(this._hoveredEventId=void 0)}}
        style="position: relative;"
      >
        <img
          src="${i}"
          alt="${e.label}"
          loading="lazy"
          @error=${e=>{const t=e.target;t&&!t.src.includes("/thumbnail/")&&(t.src=c)}}
        />
        ${s&&n?D`<video
                   autoplay
                   muted
                   .muted=${!0}
                   loop
                   playsinline
                   @loadedmetadata=${t=>this._handleHoverVideoMetadata(t,e)}
                   @timeupdate=${t=>this._handleVideoTimeUpdate(t,e)}
                   style="position: absolute; top: 0; left: 0; z-index: 2; width: 100%; height: 100%; object-fit: cover; pointer-events: none;"
                 >
                   <source src="${r}" type="video/mp4">
                   <source src="${a}" type="application/x-mpegURL">
                 </video>`:""}
      </div>
    `}_scroll(e){const t=this.renderRoot.querySelector(".events");if(!t)return;const i=.8*t.clientWidth;t.scrollBy({left:"left"===e?-i:i,behavior:"smooth"})}_capitalize(e){return e.charAt(0).toUpperCase()+e.slice(1)}_formatCameraName(e){return e.replace(/_/g," ").replace(/\b\w/g,e=>e.toUpperCase())}static get styles(){return r`
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
      
      .debug-banner {
        font-size: 10px;
        color: var(--secondary-text-color, #aaa);
        padding: 2px 8px;
        text-align: right;
        font-family: monospace;
        opacity: 0.8;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
      }

      .debug-warning {
        color: var(--warning-color, #f59e0b);
        font-size: 10px;
      }

      .events-error {
        min-height: 80px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: var(--secondary-text-color, #aaa);
        font-size: 13px;
        padding: 16px;
        text-align: center;
        background: rgba(0, 0, 0, 0.2);
        border-radius: 12px;
      }

      .events-error-detail {
        font-size: 11px;
        opacity: 0.7;
        max-width: 90%;
      }

      /* ─── Live view ────────────────────────────────────────── */

      .live-view-container {
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #1c1c1c;
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 8px;
        position: relative;
        cursor: pointer;
      }

      .live-view-container:fullscreen,
      .live-view-container:-webkit-full-screen {
        width: 100vw;
        height: 100vh;
        aspect-ratio: unset !important;
        border-radius: 0;
        margin-bottom: 0;
        background: #000;
      }

      .live-view-container:fullscreen .live-view-video,
      .live-view-container:-webkit-full-screen .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        background-color: #1c1c1c;
        transform: translateZ(0);
        will-change: transform;
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

    `}};Re._stylesInjected=!1,e([de({attribute:!1})],Re.prototype,"hass",void 0),e([he()],Re.prototype,"_config",void 0),e([he()],Re.prototype,"_events",void 0),e([he()],Re.prototype,"_selectedEvent",void 0),e([he()],Re.prototype,"_loading",void 0),e([he()],Re.prototype,"_error",void 0),e([he()],Re.prototype,"_hoveredEventId",void 0),e([he()],Re.prototype,"_liveViewError",void 0),Re=Ae=e([(e=>(t,i)=>{void 0!==i?i.addInitializer(()=>{customElements.define(e,t)}):customElements.define(e,t)})("frigate-events-card")],Re),window.customCards=window.customCards||[],window.customCards.push({type:"frigate-events-card",name:"Frigate Events Card",description:"A simple card for displaying recent Frigate detection events",preview:!0,documentationURL:"https://github.com/saihgupr/frigate-events-card"}),console.info(`%c FRIGATE-EVENTS-CARD v${Te} %c Loaded `,"color: white; background: #3b82f6; font-weight: bold;","color: #3b82f6; background: white;");export{Re as FrigateEventsCard};
