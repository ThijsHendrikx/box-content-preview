import throttle from 'lodash/throttle';
import api from '../../api';
import BaseViewer from '../BaseViewer';
import Browser from '../../Browser';
import Controls from '../../Controls';
import PageControls from '../../PageControls';
import DocFindBar from './DocFindBar';
import Popup from '../../Popup';
import RepStatus from '../../RepStatus';
import PreviewError from '../../PreviewError';
import ThumbnailsSidebar from '../../ThumbnailsSidebar';
import {
    ANNOTATOR_EVENT,
    CLASS_BOX_PREVIEW_FIND_BAR,
    CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE_ACTIVE,
    CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE,
    CLASS_BOX_PREVIEW_THUMBNAILS_CONTAINER,
    CLASS_BOX_PREVIEW_THUMBNAILS_OPEN_ACTIVE,
    CLASS_BOX_PREVIEW_THUMBNAILS_OPEN,
    CLASS_CRAWLER,
    CLASS_HIDDEN,
    CLASS_IS_SCROLLABLE,
    DOC_STATIC_ASSETS_VERSION,
    ENCODING_TYPES,
    PERMISSION_DOWNLOAD,
    PRELOAD_REP_NAME,
    QUERY_PARAM_ENCODING,
    STATUS_SUCCESS
} from '../../constants';
import { checkPermission, getRepresentation } from '../../file';
import { appendQueryParams, createAssetUrlCreator, getMidpoint, getDistance, getClosestPageToPinch } from '../../util';
import {
    ICON_PRINT_CHECKMARK,
    ICON_ZOOM_OUT,
    ICON_ZOOM_IN,
    ICON_FULLSCREEN_IN,
    ICON_FULLSCREEN_OUT,
    ICON_THUMBNAILS_TOGGLE
} from '../../icons/icons';
import { JS, PRELOAD_JS, CSS } from './docAssets';
import { ERROR_CODE, VIEWER_EVENT, LOAD_METRIC, USER_DOCUMENT_THUMBNAIL_EVENTS } from '../../events';
import Timer from '../../Timer';

const CURRENT_PAGE_MAP_KEY = 'doc-current-page-map';
const DEFAULT_SCALE_DELTA = 1.1;
const IS_SAFARI_CLASS = 'is-safari';
const LOAD_TIMEOUT_MS = 180000; // 3 min timeout
const MAX_PINCH_SCALE_VALUE = 3;
const MAX_SCALE = 10.0;
const MIN_PINCH_SCALE_DELTA = 0.01;
const MIN_PINCH_SCALE_VALUE = 0.25;
const MIN_SCALE = 0.1;
const MINIMUM_RANGE_REQUEST_FILE_SIZE_NON_US = 26214400; // 25MB
const MOBILE_MAX_CANVAS_SIZE = 2949120; // ~3MP 1920x1536
const PAGES_UNIT_NAME = 'pages';
const PINCH_PAGE_CLASS = 'pinch-page';
const PINCHING_CLASS = 'pinching';
const PRINT_DIALOG_TIMEOUT_MS = 500;
const RANGE_REQUEST_CHUNK_SIZE_NON_US = 524288; // 512KB
const RANGE_REQUEST_CHUNK_SIZE_US = 1048576; // 1MB
const SAFARI_PRINT_TIMEOUT_MS = 1000; // Wait 1s before trying to print
const SCROLL_END_TIMEOUT = this.isMobile ? 500 : 250;
const SCROLL_EVENT_THROTTLE_INTERVAL = 200;
const THUMBNAILS_SIDEBAR_TRANSITION_TIME = 301; // 301ms
const THUMBNAILS_SIDEBAR_TOGGLED_MAP_KEY = 'doc-thumbnails-toggled-map';
// List of metrics to be emitted only once per session
const METRICS_WHITELIST = [
    USER_DOCUMENT_THUMBNAIL_EVENTS.CLOSE,
    USER_DOCUMENT_THUMBNAIL_EVENTS.NAVIGATE,
    USER_DOCUMENT_THUMBNAIL_EVENTS.OPEN
];

class DocBaseViewer extends BaseViewer {
    //--------------------------------------------------------------------------
    // Public
    //--------------------------------------------------------------------------

    /** @property {string} - Tracks the type of encoding, if applicable, that was requested for the viewable content */
    encoding;

    /**
     * @inheritdoc
     */
    constructor(options) {
        super(options);

        // Bind context for callbacks
        this.handleAssetAndRepLoad = this.handleAssetAndRepLoad.bind(this);
        this.print = this.print.bind(this);
        this.setPage = this.setPage.bind(this);
        this.zoomIn = this.zoomIn.bind(this);
        this.zoomOut = this.zoomOut.bind(this);
        this.pagerenderedHandler = this.pagerenderedHandler.bind(this);
        this.pagechangeHandler = this.pagechangeHandler.bind(this);
        this.pagesinitHandler = this.pagesinitHandler.bind(this);
        this.throttledScrollHandler = this.getScrollHandler().bind(this);
        this.pinchToZoomStartHandler = this.pinchToZoomStartHandler.bind(this);
        this.pinchToZoomChangeHandler = this.pinchToZoomChangeHandler.bind(this);
        this.pinchToZoomEndHandler = this.pinchToZoomEndHandler.bind(this);
        this.emitMetric = this.emitMetric.bind(this);
        this.toggleThumbnails = this.toggleThumbnails.bind(this);
        this.onThumbnailSelectHandler = this.onThumbnailSelectHandler.bind(this);
    }

    /**
     * @inheritdoc
     */
    setup() {
        if (this.isSetup) {
            return;
        }

        // Call super() to set up common layout
        super.setup();

        this.docEl = this.createViewer(document.createElement('div'));
        this.docEl.classList.add('bp-doc');
        this.docEl.tabIndex = '0';

        if (Browser.getName() === 'Safari') {
            this.docEl.classList.add(IS_SAFARI_CLASS);
        }

        // We disable native pinch-to-zoom and double tap zoom on mobile to force users to use
        // our viewer's zoom controls
        if (this.isMobile) {
            const metaEl = document.createElement('meta');
            metaEl.setAttribute('name', 'viewport');
            metaEl.setAttribute('content', 'width=device-width, initial-scale=1, user-scalable=no');
            document.getElementsByTagName('head')[0].appendChild(metaEl);
        }

        this.viewerEl = this.docEl.appendChild(document.createElement('div'));
        this.viewerEl.classList.add('pdfViewer');
        this.loadTimeout = LOAD_TIMEOUT_MS;

        this.startPageNum = this.getStartPage(this.startAt);

        if (this.options.enableThumbnailsSidebar) {
            this.thumbnailsSidebarEl = document.createElement('div');
            this.thumbnailsSidebarEl.className = `${CLASS_BOX_PREVIEW_THUMBNAILS_CONTAINER}`;
            this.thumbnailsSidebarEl.setAttribute('data-testid', 'thumbnails-sidebar');
            this.thumbnailsSidebarEl.tabIndex = 0;
            this.rootEl.insertBefore(this.thumbnailsSidebarEl, this.containerEl);
        }
    }

    /**
     * [destructor]
     *
     * @return {void}
     */
    destroy() {
        this.unbindDOMListeners();

        // Clean up print blob
        this.printBlob = null;

        if (this.printURL) {
            URL.revokeObjectURL(this.printURL);
        }

        if (this.pageControls) {
            this.pageControls.removeListener('pagechange', this.setPage);
        }

        if (this.controls && typeof this.controls.destroy === 'function') {
            this.controls.destroy();
        }

        // Clean up the find bar
        if (this.findBar) {
            this.findBar.destroy();
            this.findBar.removeListener(VIEWER_EVENT.metric, this.emitMetric);
        }

        // Clean up PDF network requests
        if (this.pdfLoadingTask) {
            try {
                this.pdfLoadingTask.destroy();
            } catch (e) {
                // Ignore these errors
            }
        }

        // Clean up viewer and PDF document object
        if (this.pdfViewer) {
            this.pdfViewer.cleanup();

            if (this.pdfViewer.pdfDocument) {
                this.pdfViewer.pdfDocument.destroy();
            }
        }

        if (this.printPopup) {
            this.printPopup.destroy();
        }

        if (this.thumbnailsSidebar) {
            this.thumbnailsSidebar.destroy();
        }

        if (this.thumbnailsSidebarEl) {
            // Since we are cleaning up make sure the thumbnails open class is
            // removed so that the content div shifts back left
            this.rootEl.classList.remove(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN);
            this.thumbnailsSidebarEl.remove();
            this.thumbnailsSidebarEl = null;
        }

        super.destroy();
    }

    /**
     * Converts a value and unit to page number
     *
     * @param {Object} startAt - the unit and value that describes where to start the preview
     * @return {number|undefined} a page number > 0
     */
    getStartPage(startAt = {}) {
        let convertedValue;

        const { unit, value } = startAt;

        if (!value || !unit) {
            return convertedValue;
        }

        if (unit === PAGES_UNIT_NAME) {
            convertedValue = parseInt(value, 10);

            if (!convertedValue || convertedValue < 1) {
                // Negative values aren't allowed, fall back to default behavior
                return undefined;
            }
        } else {
            console.error('Invalid unit for start:', unit); // eslint-disable-line no-console
        }

        return convertedValue;
    }

    /**
     * Prefetches assets for a document.
     *
     * @param {boolean} [options.assets] - Whether or not to prefetch static assets
     * @param {boolean} [options.preload] - Whether or not to prefetch preload content
     * @param {boolean} [options.content] - Whether or not to prefetch rep content
     * @return {void}
     */
    prefetch({ assets = true, preload = true, content = true }) {
        const { file, representation } = this.options;
        const isWatermarked = file && file.watermark_info && file.watermark_info.is_watermarked;

        if (assets) {
            this.prefetchAssets(JS, CSS);
            this.prefetchAssets(PRELOAD_JS, [], true);
        }

        if (preload && !isWatermarked) {
            const preloadRep = getRepresentation(file, PRELOAD_REP_NAME);
            if (preloadRep && this.isRepresentationReady(preloadRep)) {
                const { url_template: template } = preloadRep.content;

                // Prefetch as blob since preload needs to load image as a blob
                api.get(this.createContentUrlWithAuthParams(template), { type: 'blob' });
            }
        }

        if (content && !isWatermarked && this.isRepresentationReady(representation)) {
            const { url_template: template } = representation.content;
            api.get(this.createContentUrlWithAuthParams(template), { type: 'document' });
        }
    }

    /**
     * Shows a preload (first page as an image) while the full document loads.
     *
     * @return {void}
     */
    showPreload() {
        const { file } = this.options;
        const isWatermarked = file && file.watermark_info && file.watermark_info.is_watermarked;

        // Don't show preload if there's a cached page or startAt is set and > 1 since preloads are only for the 1st page
        // Also don't show preloads for watermarked files
        if (
            !this.preloader ||
            isWatermarked ||
            ((this.startPageNum && this.startPageNum !== 1) || this.getCachedPage() !== 1)
        ) {
            return;
        }

        // Don't show preload if there is no preload rep, the 'preload' viewer option isn't set, or the rep isn't ready
        const preloadRep = getRepresentation(file, PRELOAD_REP_NAME);
        if (!preloadRep || !this.getViewerOption('preload') || RepStatus.getStatus(preloadRep) !== STATUS_SUCCESS) {
            return;
        }

        const { url_template: template } = preloadRep.content;
        const preloadUrlWithAuth = this.createContentUrlWithAuthParams(template);
        this.startPreloadTimer();
        this.preloader.showPreload(preloadUrlWithAuth, this.containerEl);
    }

    /**
     * Cleans up the preload (first page as an image). Should be called when full
     * document is loaded.
     *
     * @return {void}
     */
    hidePreload() {
        if (this.preloader) {
            this.preloader.hidePreload();
        }
    }

    /**
     * Loads a document.
     *
     * @public
     * @return {Promise} Promise to resolve assets
     */
    load() {
        super.load();
        this.showPreload();

        const template = this.options.representation.content.url_template;
        this.pdfUrl = this.createContentUrlWithAuthParams(template);

        return Promise.all([this.loadAssets(JS, CSS), this.getRepStatus().getPromise()])
            .then(this.handleAssetAndRepLoad)
            .catch(this.handleAssetError);
    }

    /**
     * Loads a document after assets and representation are ready.
     *
     * @override
     * @return {void}
     */
    handleAssetAndRepLoad() {
        this.setupPdfjs();
        this.initViewer(this.pdfUrl);
        this.initPrint();
        this.initFind();

        super.handleAssetAndRepLoad();
    }

    /**
     * Initializes the Find Bar and Find Controller
     *
     * @return {void}
     */
    initFind() {
        this.findBarEl = this.containerEl.appendChild(document.createElement('div'));
        this.findBarEl.classList.add(CLASS_BOX_PREVIEW_FIND_BAR);

        /* global PDFJS */
        this.findController = new PDFJS.PDFFindController({
            pdfViewer: this.pdfViewer
        });
        this.pdfViewer.setFindController(this.findController);

        // Only initialize the find bar if the user has download permissions on
        // the file. Users without download permissions shouldn't be able to
        // interact with the text layer
        const canDownload = checkPermission(this.options.file, PERMISSION_DOWNLOAD);
        if (this.getViewerOption('disableFindBar')) {
            return;
        }
        this.findBar = new DocFindBar(this.findBarEl, this.findController, canDownload);
        this.findBar.addListener(VIEWER_EVENT.metric, this.emitMetric);
    }

    /**
     * Scrolls to and highlights the next occurences of a phrase in the document using the DocFindBar
     *
     * @public
     * @param {string} phrase - Phrase to find
     * @param {boolean} [openFindBar] - Option to open the findbar on find
     * @return {void}
     */
    find(phrase, openFindBar = false) {
        if (!this.findBar) {
            return;
        }

        // Go to page one so that we can find the first occurence in the document
        this.setPage(1);
        this.findBar.setFindFieldElValue(phrase);
        this.findBar.findFieldHandler();

        if (openFindBar) {
            this.findBar.open();
        }
    }

    /**
     * Ensures that the print blob is loaded & updates the print UI.
     *
     * @return {void}
     */
    print() {
        // If print blob is not ready, fetch it
        if (!this.printBlob) {
            this.fetchPrintBlob(this.pdfUrl).then(this.print);

            // Show print dialog after PRINT_DIALOG_TIMEOUT_MS
            this.printDialogTimeout = setTimeout(() => {
                this.printPopup.show(__('print_loading'), __('print'), () => {
                    this.printPopup.hide();
                    this.browserPrint();
                });

                this.printPopup.disableButton();
                this.printDialogTimeout = null;
            }, PRINT_DIALOG_TIMEOUT_MS);
            return;
        }

        // Immediately print if either printing is ready within PRINT_DIALOG_TIMEOUT_MS
        // or if popup is not visible (e.g. from initiating print again)
        if (this.printDialogTimeout || !this.printPopup.isVisible()) {
            clearTimeout(this.printDialogTimeout);
            this.browserPrint();
        } else {
            // Update popup UI to reflect that print is ready
            this.printPopup.enableButton();
            this.printPopup.messageEl.textContent = __('print_ready');
            this.printPopup.loadingIndicator.classList.add(CLASS_HIDDEN);
            this.printPopup.printCheckmark.classList.remove(CLASS_HIDDEN);
        }
    }

    /**
     * Go to previous page
     *
     * @return {void}
     */
    previousPage() {
        this.setPage(this.pdfViewer.currentPageNumber - 1);
    }

    /**
     * Go to next page
     *
     * @return {void}
     */
    nextPage() {
        this.setPage(this.pdfViewer.currentPageNumber + 1);
    }

    /**
     * Go to specified page
     *
     * @param {number} pageNumber - Page to navigate to
     * @return {void}
     */
    setPage(pageNumber) {
        const parsedPageNumber = parseInt(pageNumber, 10);
        if (!parsedPageNumber || parsedPageNumber < 1 || parsedPageNumber > this.pdfViewer.pagesCount) {
            return;
        }

        this.pdfViewer.currentPageNumber = parsedPageNumber;
        this.cachePage(this.pdfViewer.currentPageNumber);

        if (this.thumbnailsSidebar) {
            this.thumbnailsSidebar.setCurrentPage(parsedPageNumber);
        }
    }

    /**
     * Gets the cached current page.
     *
     * @return {number} Current page
     */
    getCachedPage() {
        let page = 1;

        if (this.cache.has(CURRENT_PAGE_MAP_KEY)) {
            const currentPageMap = this.cache.get(CURRENT_PAGE_MAP_KEY);
            page = currentPageMap[this.options.file.id] || page;
        }

        return page;
    }

    /**
     * Sets the current page into localstorage if available. Otherwise saves
     * it in-memory as a property on the document viewer.
     *
     * @param {number} page - Current page
     * @return {void}
     */
    cachePage(page) {
        let currentPageMap = {};
        if (this.cache.has(CURRENT_PAGE_MAP_KEY)) {
            currentPageMap = this.cache.get(CURRENT_PAGE_MAP_KEY);
        }

        currentPageMap[this.options.file.id] = page;
        this.cache.set(CURRENT_PAGE_MAP_KEY, currentPageMap, true /* useLocalStorage */);
    }

    /**
     * Zoom into document.
     *
     * @param {number} ticks - Number of times to zoom in
     * @return {void}
     */
    zoomIn(ticks = 1) {
        let numTicks = ticks;
        let newScale = this.pdfViewer.currentScale;
        do {
            newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(3);
            newScale = Math.min(MAX_SCALE, newScale);
            numTicks -= 1;
        } while (numTicks > 0 && newScale < MAX_SCALE);

        if (this.pdfViewer.currentScale !== newScale) {
            this.emit('zoom', {
                zoom: newScale,
                canZoomOut: true,
                canZoomIn: newScale < MAX_SCALE
            });
        }
        this.pdfViewer.currentScaleValue = newScale;
    }

    /**
     * Zoom out of document.
     *
     * @param {number} ticks - Number of times to zoom out
     * @return {void}
     */
    zoomOut(ticks = 1) {
        let numTicks = ticks;
        let newScale = this.pdfViewer.currentScale;
        do {
            newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(3);
            newScale = Math.max(MIN_SCALE, newScale);
            numTicks -= 1;
        } while (numTicks > 0 && newScale > MIN_SCALE);

        if (this.pdfViewer.currentScale !== newScale) {
            this.emit('zoom', {
                zoom: newScale,
                canZoomOut: newScale > MIN_SCALE,
                canZoomIn: true
            });
        }
        this.pdfViewer.currentScaleValue = newScale;
    }

    /**
     * Handles keyboard events for document viewer.
     *
     * @param {string} key - keydown key
     * @param {Object} event - Key event
     * @return {boolean} consumed or not
     */
    onKeydown(key, event) {
        switch (key) {
            case 'ArrowLeft':
                this.previousPage();
                break;
            case 'ArrowRight':
                this.nextPage();
                break;
            case '[':
                this.previousPage();
                break;
            case ']':
                this.nextPage();
                break;
            default:
                if (this.findBar) {
                    return this.findBar.onKeydown(event);
                }
                return false;
        }

        return true;
    }

    /**
     * Emits a viewer metric. Useful for unpacking a message that comes from another class.
     *
     * @protected
     * @emits metric
     * @param {Object} event - Event object
     * @return {void}
     */
    emitMetric({ name, data }) {
        super.emitMetric(name, data);
    }

    //--------------------------------------------------------------------------
    // Protected
    //--------------------------------------------------------------------------

    /**
     * Loads PDF.js with provided PDF.
     *
     * @protected
     * @param {string} pdfUrl - The URL of the PDF to load
     * @return {Promise} Promise to initialize Viewer
     */
    initViewer(pdfUrl) {
        this.bindDOMListeners();

        // Initialize pdf.js in container
        this.pdfViewer = this.initPdfViewer();

        // Use chunk size set in viewer options if available
        let rangeChunkSize = this.getViewerOption('rangeChunkSize');

        // If range requests are disabled, request the gzip compressed version of the representation
        this.encoding = PDFJS.disableRange ? ENCODING_TYPES.GZIP : undefined;

        // Otherwise, use large chunk size if locale is en-US and the default,
        // smaller chunk size if not. This is using a rough assumption that
        // en-US users have higher bandwidth to Box.
        if (!rangeChunkSize) {
            rangeChunkSize =
                this.options.location.locale === 'en-US'
                    ? RANGE_REQUEST_CHUNK_SIZE_US
                    : RANGE_REQUEST_CHUNK_SIZE_NON_US;
        }

        let url = pdfUrl;

        // Apply encoding request to the content request
        if (this.encoding) {
            url = appendQueryParams(url, {
                [QUERY_PARAM_ENCODING]: this.encoding
            });
        }

        const docInitParams = {
            url,
            rangeChunkSize
        };

        // Fix incorrectly cached range requests on older versions of iOS webkit browsers,
        // see: https://bugs.webkit.org/show_bug.cgi?id=82672
        if (Browser.isIOS()) {
            docInitParams.httpHeaders = {
                'If-None-Match': 'webkit-no-cache'
            };
        }

        // Start timing document load
        this.startLoadTimer();

        // Load PDF from representation URL and set as document for pdf.js. Cache
        // the loading task so we can cancel if needed
        this.pdfLoadingTask = PDFJS.getDocument(docInitParams);
        return this.pdfLoadingTask
            .then((doc) => {
                this.pdfViewer.setDocument(doc);

                if (this.shouldThumbnailsBeToggled()) {
                    this.rootEl.classList.add(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN);
                    this.emit(VIEWER_EVENT.thumbnailsOpen);
                    this.resize();
                }

                const { linkService } = this.pdfViewer;
                if (linkService instanceof PDFJS.PDFLinkService) {
                    linkService.setDocument(doc, pdfUrl);
                    linkService.setViewer(this.pdfViewer);
                }
            })
            .catch((err) => {
                // eslint-disable-next-line
                console.error(err);

                // pdf.js gives us the status code in their error message
                const { status, message } = err;

                // Display a generic error message but log the real one
                const error =
                    status === 202
                        ? new PreviewError(
                            ERROR_CODE.DELETED_REPS,
                            __('error_refresh'),
                            { isRepDeleted: true },
                            message
                        )
                        : new PreviewError(ERROR_CODE.CONTENT_DOWNLOAD, __('error_document'), message);
                this.handleDownloadError(error, pdfUrl);
            });
    }

    /**
     * Initialize pdf.js viewer.
     *
     * @protected
     * @override
     * @return {PDFJS.PDFViewer} PDF viewer type
     */
    initPdfViewer() {
        return new PDFJS.PDFViewer({
            container: this.docEl,
            linkService: new PDFJS.PDFLinkService(),
            // Enhanced text selection uses more memory, so disable on mobile
            enhanceTextSelection: !this.isMobile
        });
    }

    /**
     * Re-sizing logic.
     *
     * @protected
     * @override
     * @return {void}
     */
    resize() {
        if (!this.pdfViewer || !this.somePageRendered) {
            if (this.preloader) {
                this.preloader.resize();
            }
            return;
        }

        // Save page and return after resize
        const { currentPageNumber } = this.pdfViewer;

        this.pdfViewer.currentScaleValue = this.pdfViewer.currentScaleValue || 'auto';
        this.pdfViewer.update();

        this.setPage(currentPageNumber);

        if (this.thumbnailsSidebar) {
            this.thumbnailsSidebar.resize();
        }

        super.resize();
    }

    /**
     * Starts timer for preload event
     *
     * @protected
     * @return {void}
     */
    startPreloadTimer() {
        const { file } = this.options;
        const tag = Timer.createTag(file.id, LOAD_METRIC.preloadTime);
        Timer.start(tag);
    }

    /**
     * Stop and report time to preload document
     *
     * @protected
     * @return {void}
     */
    stopPreloadTimer() {
        const { file } = this.options;
        const tag = Timer.createTag(file.id, LOAD_METRIC.preloadTime);
        const time = Timer.get(tag);

        if (!time || !time.start) {
            return;
        }

        Timer.stop(tag);
        this.emitMetric({
            name: LOAD_METRIC.previewPreloadEvent,
            data: time.elapsed
        });
        Timer.reset(tag);
    }

    /**
     * Callback for preload event, from preloader.
     *
     * @protected
     * @return {void}
     */
    onPreload() {
        const { logger } = this.options;
        logger.setPreloaded();
        this.stopPreloadTimer();
        this.resetLoadTimeout(); // Some content is visible - reset load timeout
    }

    //--------------------------------------------------------------------------
    // Private
    //--------------------------------------------------------------------------

    /**
     * Sets options for PDF.js.
     *
     * @return {void}
     * @private
     */
    setupPdfjs() {
        // Set PDFJS worker & character maps
        const { file, location } = this.options;
        const { size, watermark_info: watermarkInfo } = file;
        const assetUrlCreator = createAssetUrlCreator(location);

        // Set pdf.js worker, image, and character map locations
        PDFJS.workerSrc = assetUrlCreator(`third-party/doc/${DOC_STATIC_ASSETS_VERSION}/pdf.worker.min.js`);
        PDFJS.imageResourcesPath = assetUrlCreator(`third-party/doc/${DOC_STATIC_ASSETS_VERSION}/images/`);
        PDFJS.cMapUrl = `${location.staticBaseURI}third-party/doc/${DOC_STATIC_ASSETS_VERSION}/cmaps/`;
        PDFJS.cMapPacked = true;

        // Open links in new tab
        PDFJS.externalLinkTarget = PDFJS.LinkTarget.BLANK;

        // Disable streaming via fetch until performance is improved
        PDFJS.disableStream = true;

        // Disable font faces on IOS 10.3.X
        // @NOTE(JustinHoldstock) 2017-04-11: Check to remove this after next IOS release after 10.3.1
        PDFJS.disableFontFace = PDFJS.disableFontFace || Browser.hasFontIssue();

        // Disable range requests for files smaller than MINIMUM_RANGE_REQUEST_FILE_SIZE (25MB) for
        // previews outside of the US since the additional latency overhead per range request can be
        // more than the additional time for a continuous request. This also overrides any range request
        // disabling that may be set by pdf.js's compatibility checking since the browsers we support
        // should all be able to properly handle range requests.
        PDFJS.disableRange = location.locale !== 'en-US' && size < MINIMUM_RANGE_REQUEST_FILE_SIZE_NON_US;

        // Disable range requests for watermarked files since they are streamed
        PDFJS.disableRange = PDFJS.disableRange || (watermarkInfo && watermarkInfo.is_watermarked);

        // Disable text layer if user doesn't have download permissions
        PDFJS.disableTextLayer =
            !checkPermission(file, PERMISSION_DOWNLOAD) || !!this.getViewerOption('disableTextLayer');

        // Decrease mobile canvas size to ~3MP (1920x1536)
        PDFJS.maxCanvasPixels = this.isMobile ? MOBILE_MAX_CANVAS_SIZE : PDFJS.maxCanvasPixels;

        // Do not disable create object URL in IE11 or iOS Chrome - pdf.js issues #3977 and #8081 are
        // not applicable to Box's use case and disabling causes performance issues
        PDFJS.disableCreateObjectURL = false;
    }

    /**
     * Sets up print notification & prepare PDF for printing.
     *
     * @private
     * @return {void}
     */
    initPrint() {
        this.printPopup = new Popup(this.rootEl);

        const printCheckmark = document.createElement('div');
        printCheckmark.className = `bp-print-check ${CLASS_HIDDEN}`;
        printCheckmark.innerHTML = ICON_PRINT_CHECKMARK.trim();

        const loadingIndicator = document.createElement('div');
        loadingIndicator.classList.add(CLASS_CRAWLER);
        loadingIndicator.innerHTML = `
            <div></div>
            <div></div>
            <div></div>`.trim();

        this.printPopup.addContent(loadingIndicator, true);
        this.printPopup.addContent(printCheckmark, true);

        // Save a reference so they can be hidden or shown later.
        this.printPopup.loadingIndicator = loadingIndicator;
        this.printPopup.printCheckmark = printCheckmark;
    }

    /**
     * Add page IDs to each page
     *
     * @private
     * @return {void}
     */
    setupPageIds() {
        const pageEls = this.containerEl.querySelectorAll('.page');
        [].forEach.call(pageEls, (pageEl) => {
            /* eslint-disable no-param-reassign */
            const { pageNumber } = pageEl.dataset;
            if (pageNumber) {
                pageEl.id = `bp-page-${pageNumber}`;
            }
            /* eslint-enable no-param-reassign */
        });
    }

    /**
     * Fetches PDF and converts to blob for printing.
     *
     * @private
     * @param {string} pdfUrl - URL to PDF
     * @return {Promise} Promise setting print blob
     */
    fetchPrintBlob(pdfUrl) {
        return api.get(pdfUrl, { type: 'blob' }).then((blob) => {
            this.printBlob = blob;
        });
    }

    /**
     * Handles logic for printing the PDF representation in browser.
     *
     * @private
     * @return {void}
     */
    browserPrint() {
        // For IE & Edge, use the open or save dialog since we can't open
        // in a new tab due to security restrictions, see:
        // http://stackoverflow.com/questions/24007073/open-links-made-by-createobjecturl-in-ie11
        if (typeof window.navigator.msSaveOrOpenBlob === 'function') {
            const printResult = window.navigator.msSaveOrOpenBlob(this.printBlob, 'print.pdf');

            // If open/save notification is not shown, broadcast error
            if (!printResult) {
                this.emit('printerror');
            } else {
                this.emit('printsuccess');
            }

            // For other browsers, open and print in a new tab
        } else {
            if (!this.printURL) {
                this.printURL = URL.createObjectURL(this.printBlob);
            }

            const printResult = window.open(this.printURL);

            // Open print popup if possible
            if (printResult && typeof printResult.print === 'function') {
                const browser = Browser.getName();

                // Chrome supports printing on load
                if (browser === 'Chrome') {
                    printResult.addEventListener('load', () => {
                        printResult.print();
                    });

                    // Safari print on load produces blank page, so we use a timeout
                } else if (browser === 'Safari') {
                    setTimeout(() => {
                        printResult.print();
                    }, SAFARI_PRINT_TIMEOUT_MS);
                }

                // Firefox has a blocking bug: https://bugzilla.mozilla.org/show_bug.cgi?id=911444
            }

            // If new window/tab was blocked, broadcast error
            if (!printResult || printResult.closed || typeof printResult.closed === 'undefined') {
                this.emit('printerror');
            } else {
                this.emit('printsuccess');
            }
        }
    }

    /**
     * Creates UI for preview controls.
     *
     * @private
     * @return {void}
     */
    loadUI() {
        this.controls = new Controls(this.containerEl);
        this.pageControls = new PageControls(this.controls, this.docEl);
        this.pageControls.addListener('pagechange', this.setPage);
        this.bindControlListeners();
    }

    //--------------------------------------------------------------------------
    // Event Listeners
    //--------------------------------------------------------------------------

    /**
     * Binds DOM listeners for document viewer.
     *
     * @protected
     * @return {void}
     */
    bindDOMListeners() {
        // When page structure is initialized, set default zoom, load controls,
        // and broadcast that preview has loaded
        this.docEl.addEventListener('pagesinit', this.pagesinitHandler);

        // When a page is rendered, update scale
        this.docEl.addEventListener('pagerendered', this.pagerenderedHandler);

        // Update page number when page changes
        this.docEl.addEventListener('pagechange', this.pagechangeHandler);

        // Detects scroll so an event can be fired
        this.docEl.addEventListener('scroll', this.throttledScrollHandler);

        if (this.hasTouch) {
            this.docEl.addEventListener('touchstart', this.pinchToZoomStartHandler);
            this.docEl.addEventListener('touchmove', this.pinchToZoomChangeHandler);
            this.docEl.addEventListener('touchend', this.pinchToZoomEndHandler);
        }
    }

    /**
     * Unbinds DOM listeners for document viewer.
     *
     * @protected
     * @return {void}
     */
    unbindDOMListeners() {
        if (this.docEl) {
            this.docEl.removeEventListener('pagesinit', this.pagesinitHandler);
            this.docEl.removeEventListener('pagerendered', this.pagerenderedHandler);
            this.docEl.removeEventListener('pagechange', this.pagechangeHandler);
            this.docEl.removeEventListener('scroll', this.throttledScrollHandler);

            if (this.hasTouch) {
                this.docEl.removeEventListener('touchstart', this.pinchToZoomStartHandler);
                this.docEl.removeEventListener('touchmove', this.pinchToZoomChangeHandler);
                this.docEl.removeEventListener('touchend', this.pinchToZoomEndHandler);
            }
        }
    }

    /**
     * Binds listeners for document controls
     *
     * @protected
     * @return {void}
     */
    bindControlListeners() {
        if (this.options.enableThumbnailsSidebar) {
            this.controls.add(
                __('toggle_thumbnails'),
                this.toggleThumbnails,
                'bp-toggle-thumbnails-icon',
                ICON_THUMBNAILS_TOGGLE
            );
        }

        this.controls.add(__('zoom_out'), this.zoomOut, 'bp-doc-zoom-out-icon', ICON_ZOOM_OUT);
        this.controls.add(__('zoom_in'), this.zoomIn, 'bp-doc-zoom-in-icon', ICON_ZOOM_IN);

        this.pageControls.add(this.pdfViewer.currentPageNumber, this.pdfViewer.pagesCount);

        this.controls.add(
            __('enter_fullscreen'),
            this.toggleFullscreen,
            'bp-enter-fullscreen-icon',
            ICON_FULLSCREEN_IN
        );
        this.controls.add(__('exit_fullscreen'), this.toggleFullscreen, 'bp-exit-fullscreen-icon', ICON_FULLSCREEN_OUT);
    }

    /**
     * Handler for 'pagesinit' event.
     *
     * @private
     * @return {void}
     */
    pagesinitHandler() {
        this.pdfViewer.currentScaleValue = 'auto';

        this.loadUI();

        const { pagesCount, currentScale } = this.pdfViewer;

        // Set page to the user-defined page, previously opened page, or first page
        const startPage = this.startPageNum || this.getCachedPage();
        this.setPage(startPage);

        // Make document scrollable after pages are set up so scrollbars don't mess with autoscaling
        this.docEl.classList.add(CLASS_IS_SCROLLABLE);

        // Broadcast that preview has 'loaded' when page structure is available
        if (!this.loaded) {
            this.loaded = true;
            this.emit(VIEWER_EVENT.load, {
                encoding: this.encoding,
                numPages: pagesCount,
                endProgress: false, // Indicate that viewer will end progress later
                scale: currentScale
            });

            // Add page IDs to each page after page structure is available
            this.setupPageIds();
        }
    }

    /**
     * Initialize the Thumbnails Sidebar
     *
     * @return {void}
     */
    initThumbnails() {
        this.thumbnailsSidebar = new ThumbnailsSidebar(this.thumbnailsSidebarEl, this.pdfViewer);
        this.thumbnailsSidebar.init({
            currentPage: this.pdfViewer.currentPageNumber,
            isOpen: this.shouldThumbnailsBeToggled(),
            onSelect: this.onThumbnailSelectHandler
        });
    }

    /**
     * Handles the selection of a thumbnail for navigation
     *
     * @param {number} pageNum - the page number
     * @return {void}
     */
    onThumbnailSelectHandler(pageNum) {
        this.emitMetric({ name: USER_DOCUMENT_THUMBNAIL_EVENTS.NAVIGATE, data: pageNum });
        this.setPage(pageNum);
    }

    /**
     * Handler for 'pagerendered' event.
     *
     * @private
     * @param {Event} event - 'pagerendered' event
     * @return {void}
     */
    pagerenderedHandler(event) {
        const pageNumber = event.detail ? event.detail.pageNumber : undefined;

        if (pageNumber) {
            // Page rendered event
            this.emit('pagerender', pageNumber);

            // Set scale to current numerical scale & rendered page number
            this.emit('scale', {
                scale: this.pdfViewer.currentScale,
                pageNum: pageNumber
            });

            // Fire progressend event to hide progress bar and cleanup preload after a page is rendered
            if (!this.somePageRendered) {
                this.hidePreload();
                this.emit(VIEWER_EVENT.progressEnd);
                this.somePageRendered = true;

                if (this.options.enableThumbnailsSidebar) {
                    this.initThumbnails();
                    this.resize();
                }
            }
        }
    }

    /**
     * Handler for 'pagechange' event.
     *
     * @private
     * @param {Event} event - Pagechange event
     * @return {void}
     */
    pagechangeHandler(event) {
        const { pageNumber } = event;
        this.pageControls.updateCurrentPage(pageNumber);

        if (this.thumbnailsSidebar) {
            this.thumbnailsSidebar.setCurrentPage(pageNumber);
        }

        // We only set cache the current page if 'pagechange' was fired after
        // preview is loaded - this filters out pagechange events fired by
        // the viewer's initialization
        if (this.loaded) {
            this.cachePage(pageNumber);
        }

        this.emit('pagefocus', pageNumber);
    }

    /** @inheritDoc */
    handleFullscreenEnter() {
        this.pdfViewer.currentScaleValue = 'page-fit';
        super.handleFullscreenEnter();
    }

    /** @inheritDoc */
    handleFullscreenExit() {
        this.pdfViewer.currentScaleValue = 'auto';
        super.handleFullscreenExit();
    }

    /**
     * Returns throttled handler. Fires an event on start and stop
     *
     * @private
     * @return {void}
     */
    getScrollHandler() {
        return throttle(() => {
            // Reset the scroll timer if we are continuing a scroll
            if (this.scrollTimer) {
                clearTimeout(this.scrollTimer);
            }

            // only fire the scroll start event if this is a new scroll
            if (!this.scrollStarted) {
                this.emit('scrollstart', {
                    scrollTop: this.docEl.scrollTop,
                    scrollLeft: this.docEl.scrollLeft
                });
                this.scrollStarted = true;
            }

            this.scrollTimer = setTimeout(() => {
                this.emit('scrollend', {
                    scrollTop: this.docEl.scrollTop,
                    scrollLeft: this.docEl.scrollLeft
                });
                this.scrollStarted = false;
            }, SCROLL_END_TIMEOUT);
        }, SCROLL_EVENT_THROTTLE_INTERVAL);
    }

    /**
     * Sets up pinch to zoom behavior by wrapping zoomed divs and determining the original pinch distance.
     *
     * @protected
     * @param {Event} event - object
     * @return {void}
     */
    pinchToZoomStartHandler(event) {
        if (event.touches.length < 2) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        this.isPinching = true;

        // Determine the midpoint of our pinch event if it is not provided for us
        const touchMidpoint =
            event.pageX && event.pageY
                ? [event.pageX, event.pageY]
                : getMidpoint(
                    event.touches[0].pageX,
                    event.touches[0].pageY,
                    event.touches[1].pageX,
                    event.touches[1].pageY
                );

        // Find the page closest to the pinch
        const visiblePages = this.pdfViewer._getVisiblePages();
        this.pinchPage = getClosestPageToPinch(
            this.docEl.scrollLeft + touchMidpoint[0],
            this.docEl.scrollTop + touchMidpoint[1],
            visiblePages
        );

        // Set the scale point based on the pinch midpoint and scroll offsets
        this.scaledXOffset = this.docEl.scrollLeft - this.pinchPage.offsetLeft + touchMidpoint[0];
        this.scaledYOffset = this.docEl.scrollTop - this.pinchPage.offsetTop + touchMidpoint[1] + 15;

        this.pinchPage.style['transform-origin'] = `${this.scaledXOffset}px ${this.scaledYOffset}px`;

        // Preserve the original touch offset
        this.originalXOffset = touchMidpoint[0];
        this.originalYOffset = touchMidpoint[1];

        // Used by non-iOS browsers that do not provide a scale value
        this.originalDistance = getDistance(
            event.touches[0].pageX,
            event.touches[0].pageY,
            event.touches[1].pageX,
            event.touches[1].pageY
        );
    }

    /**
     * Updates the CSS transform zoom based on the distance of the pinch gesture.
     *
     * @protected
     * @param {Event} event - object
     * @return {void}
     */
    pinchToZoomChangeHandler(event) {
        if (!this.isPinching) {
            return;
        }

        const scale = event.scale
            ? event.scale
            : getDistance(
                event.touches[0].pageX,
                event.touches[0].pageY,
                event.touches[1].pageX,
                event.touches[1].pageY
            ) / this.originalDistance;

        const proposedNewScale = this.pdfViewer.currentScale * scale;
        if (
            scale === 1 ||
            Math.abs(this.pinchScale - scale) < MIN_PINCH_SCALE_DELTA ||
            proposedNewScale >= MAX_SCALE ||
            proposedNewScale <= MIN_SCALE ||
            scale > MAX_PINCH_SCALE_VALUE ||
            scale < MIN_PINCH_SCALE_VALUE
        ) {
            // There are a variety of circumstances where we don't want to scale'
            // 1. We haven't detected a changes
            // 2. The change isn't significant enough
            // 3. We will exceed our max or min scale
            // 4. The scale is too significant, which can lead to performance issues
            return;
        }

        this.pinchScale = scale;
        this.pinchPage.classList.add(PINCH_PAGE_CLASS);
        this.docEl.firstChild.classList.add(PINCHING_CLASS);

        this.pinchPage.style.transform = `scale(${this.pinchScale})`;
    }

    /**
     * Replaces the CSS transform with a native PDF.js zoom and scrolls to maintain positioning.
     *
     * @protected
     * @return {void}
     */
    pinchToZoomEndHandler() {
        if (!this.pinchPage || !this.isPinching || this.pinchScale === 1) {
            return;
        }

        // PDF.js zoom
        this.pdfViewer.currentScaleValue = this.pdfViewer.currentScale * this.pinchScale;

        this.pinchPage.style.transform = null;
        this.pinchPage.style['transform-origin'] = null;
        this.pinchPage.classList.remove(PINCH_PAGE_CLASS);
        this.docEl.firstChild.classList.remove(PINCHING_CLASS);

        // Scroll to correct position after zoom
        this.docEl.scroll(
            this.scaledXOffset * this.pinchScale - this.originalXOffset,
            this.scaledYOffset * this.pinchScale - this.originalYOffset + this.pinchPage.offsetTop
        );

        this.isPinching = false;
        this.originalDistance = 0;
        this.pinchScale = 1;
        this.pinchPage = null;
    }

    /**
     * Callback when the toggle thumbnail sidebar button is clicked.
     *
     * @protected
     * @return {void}
     */
    toggleThumbnails() {
        if (!this.thumbnailsSidebar) {
            return;
        }

        this.thumbnailsSidebar.toggle();

        const { pagesCount } = this.pdfViewer;

        this.cacheThumbnailsToggledState(this.thumbnailsSidebar.isOpen);

        let metricName;
        let eventName;
        if (!this.thumbnailsSidebar.isOpen) {
            this.rootEl.classList.remove(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN);
            this.rootEl.classList.add(CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE);
            this.rootEl.classList.add(CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE_ACTIVE);
            metricName = USER_DOCUMENT_THUMBNAIL_EVENTS.CLOSE;
            eventName = VIEWER_EVENT.thumbnailsClose;
        } else {
            this.rootEl.classList.remove(CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE);
            this.rootEl.classList.add(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN);
            this.rootEl.classList.add(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN_ACTIVE);
            metricName = USER_DOCUMENT_THUMBNAIL_EVENTS.OPEN;
            eventName = VIEWER_EVENT.thumbnailsOpen;
        }

        this.emitMetric({ name: metricName, data: pagesCount });
        this.emit(eventName);

        // Resize after the CSS animation to toggle the sidebar is complete
        setTimeout(() => {
            this.resize();

            // Remove the active classes to allow the container to be transitioned properly
            this.rootEl.classList.remove(CLASS_BOX_PREVIEW_THUMBNAILS_CLOSE_ACTIVE);
            this.rootEl.classList.remove(CLASS_BOX_PREVIEW_THUMBNAILS_OPEN_ACTIVE);
        }, THUMBNAILS_SIDEBAR_TRANSITION_TIME);
    }

    /**
     * Overrides the base method
     *
     * @override
     * @return {Array} - the array of metric names to be emitted only once
     */
    getMetricsWhitelist() {
        return METRICS_WHITELIST;
    }

    /**
     * Extra handling of the annotation mode enter and exit events in order to apply
     * the dark styling to the thumbnails sidebar
     * @override
     */
    handleAnnotatorEvents(data) {
        super.handleAnnotatorEvents(data);

        if (!this.thumbnailsSidebarEl) {
            return;
        }

        switch (data.event) {
            case ANNOTATOR_EVENT.modeEnter:
                this.thumbnailsSidebarEl.classList.add('bp-thumbnails-container--dark');
                break;
            case ANNOTATOR_EVENT.modeExit:
                this.thumbnailsSidebarEl.classList.remove('bp-thumbnails-container--dark');
                break;
            default:
        }
    }

    /**
     * Gets the cached thumbnails toggled state based on file id. Will retrieve from
     * localStorage if not cached.
     * @return {boolean} Whether thumbnails is toggled open or not from the cache
     */
    getCachedThumbnailsToggledState() {
        const { [this.options.file.id]: toggledOpen } = this.cache.get(THUMBNAILS_SIDEBAR_TOGGLED_MAP_KEY) || {};
        return toggledOpen;
    }

    /**
     * Caches the toggled state of the thumbnails sidebar, also saving to localStorage
     * @param {boolean} isOpen Toggled state of the sidebar
     * @return {void}
     */
    cacheThumbnailsToggledState(isOpen) {
        const thumbnailsToggledMap = this.cache.get(THUMBNAILS_SIDEBAR_TOGGLED_MAP_KEY) || {};
        const newThumbnailsToggledMap = { ...thumbnailsToggledMap, [this.options.file.id]: !!isOpen };

        this.cache.set(THUMBNAILS_SIDEBAR_TOGGLED_MAP_KEY, newThumbnailsToggledMap, true /* useLocalStorage */);
    }

    /**
     * Determines if the thumbnails sidebar should be toggled
     * @return {boolean} Whether thumbnails should be toggled open or not
     */
    shouldThumbnailsBeToggled() {
        if (!this.options.enableThumbnailsSidebar) {
            return false;
        }

        const cachedToggledState = this.getCachedThumbnailsToggledState();
        // `pdfViewer.pagesCount` isn't immediately available after pdfViewer.setDocument()
        // is called, but the numPages is available on the underlying pdfViewer.pdfDocument
        const { numPages = 0 } = this.pdfViewer && this.pdfViewer.pdfDocument;
        let toggledState = cachedToggledState;

        // If cached toggled state is anything other than false, set it to true
        // because we want the default state to be true
        if (toggledState !== false) {
            toggledState = true;
        }

        // For documents of only 1 page, default thumbnails as closed
        return toggledState && numPages > 1;
    }
}

export default DocBaseViewer;
