import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

function classNames(...classes) {
    return classes.filter(Boolean).join(' ');
}

function Modal({ open, title, children, onClose, onConfirm, confirmText = 'Save', confirmDisabled = false }) {
    if (!open) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-xl bg-white p-5 shadow-lg">
                <div className="mb-4">
                    <h3 className="text-lg font-semibold">{title}</h3>
                </div>
                <div>{children}</div>
                <div className="mt-5 flex items-center justify-end gap-2">
                    <button className="rounded border border-gray-300 px-3 py-2 text-gray-700 hover:bg-gray-50" onClick={onClose}>Cancel</button>
                    <button
                        className={classNames(
                            'rounded px-3 py-2 text-white',
                            confirmDisabled ? 'bg-indigo-300 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700'
                        )}
                        onClick={onConfirm}
                        disabled={confirmDisabled}
                    >
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>
    );
}

function Toasts({ toasts, dismiss }) {
    if (toasts.length === 0) return null;
    return (
        <div className="fixed right-4 top-4 z-50 space-y-2">
            {toasts.map((t) => (
                <div key={t.id} className={classNames('rounded-md px-4 py-2 shadow-md text-sm', t.type === 'error' ? 'bg-red-600 text-white' : 'bg-gray-900 text-white')}>
                    <div className="flex items-center gap-3">
                        <span className="flex-1">{t.message}</span>
                        <button className="text-white/70 hover:text-white" onClick={() => dismiss(t.id)}>
                            ×
                        </button>
                    </div>
                </div>
            ))}
        </div>
    );
}

function BookmarkNode({ node, depth = 0, onAddChild, onRemove, onEdit, onGo }) {
    const [open, setOpen] = useState(true);
    return (
        <div className={classNames('group rounded-md', depth > 0 ? 'ml-3' : '')}>
            <div
                className="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-2 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 cursor-pointer transition-colors"
                onClick={() => onGo(node.page)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onGo(node.page);
                    }
                }}
            >
                <button
                    aria-label={open ? 'Collapse' : 'Expand'}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpen((o) => !o);
                    }}
                    className="mt-1 inline-flex h-6 w-6 items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                    {open ? '▾' : '▸'}
                </button>
                <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-gray-800 dark:text-gray-100" title={`Go to page ${node.page}`}>{node.title}</div>
                    <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Page {node.page}</div>
                </div>
                <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button className="rounded px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50" onClick={(e) => { e.stopPropagation(); onAddChild(node.id); }}>Add</button>
                    <button className="rounded px-2 py-1 text-xs text-amber-700 hover:bg-amber-50" onClick={(e) => { e.stopPropagation(); onEdit(node.id); }}>Edit</button>
                    <button className="rounded px-2 py-1 text-xs text-rose-700 hover:bg-rose-50" onClick={(e) => { e.stopPropagation(); onRemove(node.id); }}>Remove</button>
                </div>
            </div>
            {open && node.children && node.children.length > 0 && (
                <div className="mt-2 space-y-2">
                    {node.children.map((child) => (
                        <BookmarkNode
                            key={child.id}
                            node={child}
                            depth={depth + 1}
                            onAddChild={onAddChild}
                            onRemove={onRemove}
                            onEdit={onEdit}
                            onGo={onGo}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

export default function App() {
    const [file, setFile] = useState(null);
    const [fileId, setFileId] = useState(null);
    const [numPages, setNumPages] = useState(null);
    const [tree, setTree] = useState([]);
    const [pageView, setPageView] = useState(1);
    const [scale, setScale] = useState(1.0);
    const [isUploading, setIsUploading] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isPdfLoading, setIsPdfLoading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [modalMode, setModalMode] = useState('addRoot'); // addRoot | addChild | edit
    const [modalParentId, setModalParentId] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [formTitle, setFormTitle] = useState('');
    const [formPage, setFormPage] = useState('1');
    const [toasts, setToasts] = useState([]);
    const [theme, setTheme] = useState('light'); // light | dark
    const [originalName, setOriginalName] = useState(null);
    const [activeTab, setActiveTab] = useState('bookmarks'); // bookmarks | dummy
    const [selectedPhoto, setSelectedPhoto] = useState(null);
    const [uploadedImage, setUploadedImage] = useState(null);

    const fileUrlRef = useRef(null);

    // For monolithic apps: use localhost in development, relative URLs in production
    const BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_URL ||
        (import.meta.env.DEV ? 'http://localhost:4000' : '');

    // Debug logging to help troubleshoot
    console.log('Environment:', import.meta.env.MODE);
    console.log('Backend URL:', BACKEND_BASE_URL || 'Using relative URLs (same domain)');

    function showToast(message, type = 'info', timeoutMs = 3000) {
        const id = uuidv4();
        const toast = { id, message, type };
        setToasts((t) => [...t, toast]);
        window.setTimeout(() => dismissToast(id), timeoutMs);
    }
    function dismissToast(id) {
        setToasts((t) => t.filter((x) => x.id !== id));
    }

    function createNode(title, page) {
        return { id: uuidv4(), title, page: Number(page), children: [] };
    }

    async function uploadPdf(selectedFile) {
        try {
            setIsUploading(true);
            // Reset viewer and bookmarks when a new file is selected
            setIsPdfLoading(true);
            setTree([]);
            setNumPages(null);
            setPageView(1);
            setScale(1.0);
            setFileId(null);
            setOriginalName(null);
            setFile(selectedFile);
            const fd = new FormData();
            fd.append('pdf', selectedFile);
            const resp = await axios.post(`${BACKEND_BASE_URL}/api/upload`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            setFileId(resp.data.id);
            setOriginalName(resp.data.originalName || selectedFile?.name || 'document.pdf');
            if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
            fileUrlRef.current = URL.createObjectURL(selectedFile);
            showToast('PDF uploaded');
        } catch (err) {
            console.error(err);
            showToast('Failed to upload PDF', 'error', 5000);
        } finally {
            setIsUploading(false);
        }
    }

    const onFileChange = async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        if (f.type !== 'application/pdf') {
            showToast('Please select a PDF file', 'error');
            return;
        }
        uploadPdf(f);
    };

    async function onDocumentLoadSuccess(pdf) {
        try {
            const totalPages = pdf?.numPages || 1;
            setNumPages(totalPages);
            setPageView(1);
            setIsPdfLoading(false);

            // If the PDF already has an outline, import it as initial tree (only if tree is empty)
            if (tree.length === 0 && typeof pdf.getOutline === 'function') {
                const outlineItems = await pdf.getOutline();
                if (Array.isArray(outlineItems) && outlineItems.length > 0) {
                    async function destToPageNumber(documentProxy, dest) {
                        try {
                            if (!dest) return null;
                            let explicit = dest;
                            if (typeof dest === 'string') {
                                explicit = await documentProxy.getDestination(dest);
                            }
                            if (Array.isArray(explicit)) {
                                const [ref] = explicit;
                                if (ref && typeof ref === 'object' && typeof documentProxy.getPageIndex === 'function') {
                                    const idx = await documentProxy.getPageIndex(ref);
                                    return Number(idx) + 1;
                                }
                            }
                            return null;
                        } catch {
                            return null;
                        }
                    }

                    async function mapOutline(items) {
                        const mapped = await Promise.all(items.map(async (it) => {
                            const page = await destToPageNumber(pdf, it.dest);
                            const safePage = page && page >= 1 && page <= totalPages ? page : 1;
                            const title = (it.title || '').trim() || 'Untitled';
                            const node = createNode(title, safePage);
                            const children = Array.isArray(it.items) && it.items.length > 0 ? await mapOutline(it.items) : [];
                            node.children = children;
                            return node;
                        }));
                        return mapped;
                    }

                    const imported = await mapOutline(outlineItems);
                    if (imported && imported.length > 0) {
                        setTree(imported);
                        showToast(`Imported ${imported.length} existing bookmark${imported.length > 1 ? 's' : ''}`);
                    }
                }
            }
        } catch (e) {
            console.error('Outline import failed', e);
        }
    }

    function findAndOperate(nodes, id, op) {
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].id === id) {
                op(nodes, i);
                return true;
            }
            if (nodes[i].children && nodes[i].children.length) {
                const found = findAndOperate(nodes[i].children, id, op);
                if (found) return true;
            }
        }
        return false;
    }

    function openAddRoot() {
        setModalMode('addRoot');
        setFormTitle('');
        setFormPage(String(pageView));
        setModalParentId(null);
        setEditingId(null);
        setModalOpen(true);
    }

    function openAddChild(parentId) {
        setModalMode('addChild');
        setFormTitle('');
        setFormPage(String(pageView));
        setModalParentId(parentId);
        setEditingId(null);
        setModalOpen(true);
    }

    function openEdit(id) {
        let title = '';
        let page = 1;
        findAndOperate(tree, id, (arr, i) => {
            title = arr[i].title;
            page = arr[i].page;
        });
        setModalMode('edit');
        setFormTitle(title);
        setFormPage(String(page));
        setEditingId(id);
        setModalParentId(null);
        setModalOpen(true);
    }

    function saveModal() {
        const title = (formTitle || '').trim();
        const page = parseInt(formPage, 10);
        if (!title || !page || page < 1 || (numPages ? page > numPages : false)) {
            showToast('Please provide a valid title and page number', 'error');
            return;
        }
        if (modalMode === 'addRoot') {
            setTree((t) => [...t, createNode(title, page)]);
            showToast('Bookmark added');
        } else if (modalMode === 'addChild' && modalParentId) {
            const node = createNode(title, page);
            setTree((t) => {
                const copy = JSON.parse(JSON.stringify(t));
                findAndOperate(copy, modalParentId, (arr, idx) => {
                    arr[idx].children.push(node);
                });
                return copy;
            });
            showToast('Child bookmark added');
        } else if (modalMode === 'edit' && editingId) {
            setTree((t) => {
                const copy = JSON.parse(JSON.stringify(t));
                findAndOperate(copy, editingId, (arr, i) => {
                    arr[i].title = title;
                    arr[i].page = page;
                });
                return copy;
            });
            showToast('Bookmark updated');
        }
        setModalOpen(false);
    }

    const removeNode = (id) => {
        setTree((t) => {
            const copy = JSON.parse(JSON.stringify(t));
            const idx = copy.findIndex((n) => n.id === id);
            if (idx !== -1) {
                copy.splice(idx, 1);
                return copy;
            }
            findAndOperate(copy, id, (arr, i) => arr.splice(i, 1));
            return copy;
        });
        showToast('Bookmark removed');
    };

    const goToPage = (p) => setPageView(Math.max(1, Math.min(numPages || 1, Number(p) || 1)));

    const downloadProcessed = async () => {
        if (!fileId) {
            showToast('Upload a PDF first', 'error');
            return;
        }
        setIsProcessing(true);
        try {
            function strip(node) {
                const out = { title: node.title, page: node.page };
                if (node.children && node.children.length) out.children = node.children.map(strip);
                return out;
            }
            const payload = tree.map(strip);
            const resp = await axios.post(
                `${BACKEND_BASE_URL}/api/process`,
                { id: fileId, bookmarks: payload },
                { responseType: 'blob' }
            );
            const url = window.URL.createObjectURL(new Blob([resp.data], { type: 'application/pdf' }));
            function makeBookmarkedName(name) {
                if (!name) return 'bookmarked.pdf';
                const lastDot = name.lastIndexOf('.');
                if (lastDot > 0 && lastDot < name.length - 1) {
                    const base = name.slice(0, lastDot);
                    const ext = name.slice(lastDot + 1);
                    return `${base} bookmarked.${ext}`;
                }
                return `${name} bookmarked.pdf`;
            }
            const downloadName = makeBookmarkedName(originalName || file?.name || 'document.pdf');
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadName;
            a.click();
            showToast('Downloaded processed PDF');
        } catch (err) {
            console.error(err);
            showToast('Failed to process PDF', 'error', 5000);
        } finally {
            setIsProcessing(false);
        }
    };

    const useSamplePdf = async () => {
        try {
            const response = await fetch('/sample.pdf');
            const blob = await response.blob();
            const sampleFile = new File([blob], 'sample.pdf', { type: 'application/pdf' });
            await uploadPdf(sampleFile);
        } catch (err) {
            console.error(err);
            showToast('Could not load sample PDF', 'error');
        }
    };

    const handlePhotoSelect = (e) => {
        const file = e.target.files?.[0];
        if (file) {
            if (file.type.startsWith('image/')) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    setSelectedPhoto({
                        file: file,
                        url: e.target.result,
                        name: file.name
                    });
                };
                reader.readAsDataURL(file);
            } else {
                showToast('Please select an image file', 'error');
            }
        }
    };

    const formatExtractedText = (text) => {
        if (!text) return '';

        // Split text into lines and clean up
        const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

        // Group lines into paragraphs (lines that are close together)
        const paragraphs = [];
        let currentParagraph = [];

        lines.forEach((line, index) => {
            currentParagraph.push(line);

            // If next line is empty or very short, or if this is the last line, end paragraph
            if (index === lines.length - 1 ||
                (lines[index + 1] && lines[index + 1].length < 3) ||
                (lines[index + 1] && lines[index + 1].trim() === '')) {
                if (currentParagraph.length > 0) {
                    paragraphs.push(currentParagraph.join(' '));
                    currentParagraph = [];
                }
            }
        });

        return paragraphs.join('\n\n');
    };

    function onDrop(e) {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (!f) return;
        if (f.type !== 'application/pdf') {
            showToast('Only PDF files are supported', 'error');
            return;
        }
        uploadPdf(f);
    }

    function onDragOver(e) {
        e.preventDefault();
        setDragOver(true);
    }
    function onDragLeave() {
        setDragOver(false);
    }

    useEffect(() => {
        function onKeyDown(e) {
            if (e.key === 'ArrowLeft') setPageView((p) => Math.max(1, p - 1));
            if (e.key === 'ArrowRight') setPageView((p) => Math.min(numPages || 1, p + 1));
            if ((e.ctrlKey || e.metaKey) && e.key === '=') setScale((s) => Math.min(3, parseFloat((s + 0.1).toFixed(2))));
            if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) setScale((s) => Math.max(0.5, parseFloat((s - 0.1).toFixed(2))));
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === '0') setScale(1);
        }
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [numPages]);

    useEffect(() => {
        return () => {
            if (fileUrlRef.current) URL.revokeObjectURL(fileUrlRef.current);
        };
    }, []);

    useEffect(() => {
        // Initialize theme from localStorage or system preference
        const stored = localStorage.getItem('theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const initial = stored === 'dark' || (!stored && prefersDark) ? 'dark' : 'light';
        setTheme(initial);
        const root = document.documentElement;
        root.classList.toggle('dark', initial === 'dark');

        const listener = (e) => {
            if (!stored) {
                const isDark = e.matches;
                setTheme(isDark ? 'dark' : 'light');
                root.classList.toggle('dark', isDark);
            }
        };
        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            mq.addEventListener?.('change', listener);
            return () => mq.removeEventListener?.('change', listener);
        }
    }, []);

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        localStorage.setItem('theme', next);
        document.documentElement.classList.toggle('dark', next === 'dark');
    }

    const canDownload = useMemo(() => Boolean(fileId), [fileId]);

    return (
        <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 p-6 dark:from-gray-950 dark:to-gray-900">
            <Toasts toasts={toasts} dismiss={dismissToast} />
            <div className="mx-auto max-w-7xl">
                <header className="mb-6 rounded-xl bg-white/80 p-5 shadow-sm ring-1 ring-gray-100 backdrop-blur dark:bg-gray-800/80 dark:ring-gray-700">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">PDF Bookmark Studio</h1>
                            <p className="text-sm text-gray-500 dark:text-gray-400">Create nested bookmarks for your PDFs quickly and beautifully.</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={toggleTheme}
                                aria-label="Toggle dark mode"
                                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                            >
                                {theme === 'dark' ? '🌙 Dark' : '☀️ Light'}
                            </button>
                            <button
                                onClick={useSamplePdf}
                                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                            >
                                Try Sample PDF
                            </button>
                            <label className="cursor-pointer rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                                {isUploading ? 'Uploading…' : 'Upload PDF'}
                                <input type="file" accept="application/pdf" onChange={onFileChange} className="hidden" />
                            </label>
                        </div>
                    </div>
                </header>

                {/* Tab Navigation */}
                <div className="mb-6">
                    <div className="border-b border-gray-200 dark:border-gray-700">
                        <nav className="-mb-px flex space-x-8">
                            <button
                                onClick={() => setActiveTab('bookmarks')}
                                className={classNames(
                                    'whitespace-nowrap border-b-2 py-2 px-1 text-sm font-medium',
                                    activeTab === 'bookmarks'
                                        ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                        : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                                )}
                            >
                                📚 Bookmarks
                            </button>
                            <button
                                onClick={() => setActiveTab('dummy')}
                                className={classNames(
                                    'whitespace-nowrap border-b-2 py-2 px-1 text-sm font-medium',
                                    activeTab === 'dummy'
                                        ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                        : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                                )}
                            >
                                📸 Photo Upload
                            </button>
                        </nav>
                    </div>
                </div>

                <div className="grid gap-6 lg:grid-cols-3">
                    {activeTab === 'bookmarks' ? (
                        <>
                            <section className="lg:col-span-2">
                                <div
                                    onDrop={onDrop}
                                    onDragOver={onDragOver}
                                    onDragLeave={onDragLeave}
                                    className={classNames(
                                        'relative rounded-xl border-2 border-dashed p-4 transition',
                                        dragOver ? 'border-indigo-400 bg-indigo-50/50 dark:border-indigo-500/70 dark:bg-indigo-950/30' : 'border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800'
                                    )}
                                >
                                    {!file ? (
                                        <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center text-gray-500 dark:text-gray-400">
                                            <div className="text-5xl">📄</div>
                                            <p className="text-base">Drag and drop your PDF here, or click Upload.</p>
                                            <p className="text-xs">We process files locally in your browser before sending to the server.</p>
                                            <div className="mt-2 flex items-center gap-2">
                                                <button onClick={useSamplePdf} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">Use Sample</button>
                                                <label className="cursor-pointer rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700">
                                                    {isUploading ? 'Uploading…' : 'Choose PDF'}
                                                    <input type="file" accept="application/pdf" onChange={onFileChange} className="hidden" />
                                                </label>
                                            </div>
                                        </div>
                                    ) : (
                                        <div>
                                            <div className="mb-3 flex flex-wrap items-center gap-2">
                                                <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
                                                    <button
                                                        className="rounded px-2 py-1 text-sm hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
                                                        onClick={() => setPageView((p) => Math.max(1, p - 1))}
                                                    >
                                                        Prev
                                                    </button>
                                                    <div className="text-sm text-gray-700 dark:text-gray-200">
                                                        Page
                                                        <input
                                                            value={pageView}
                                                            min={1}
                                                            max={numPages || 1}
                                                            onChange={(e) => setPageView(Number(e.target.value) || 1)}
                                                            className="mx-2 w-16 rounded border border-gray-200 px-2 py-1 text-center text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                                        />
                                                        of {numPages || '…'}
                                                    </div>
                                                    <button
                                                        className="rounded px-2 py-1 text-sm hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
                                                        onClick={() => setPageView((p) => Math.min(numPages || 1, p + 1))}
                                                    >
                                                        Next
                                                    </button>
                                                </div>
                                                <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
                                                    <button className="rounded px-2 py-1 text-sm hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700" onClick={() => setScale((s) => Math.max(0.5, parseFloat((s - 0.1).toFixed(2))))}>-</button>
                                                    <div className="w-16 text-center text-sm text-gray-700 dark:text-gray-200">{Math.round(scale * 100)}%</div>
                                                    <button className="rounded px-2 py-1 text-sm text-gray-700 dark:text-gray-200 dark:hover:bg-gray-700" onClick={() => setScale((s) => Math.min(3, parseFloat((s + 0.1).toFixed(2))))}>+</button>
                                                    <button className="rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700" onClick={() => setScale(1)}>Reset</button>
                                                </div>
                                            </div>
                                            <div className="flex justify-center">
                                                <Document key={(file && `${file.name}-${file.size}-${file.lastModified}`) || fileId || 'local'} file={file} onLoadSuccess={onDocumentLoadSuccess} loading={
                                                    <div className="flex h-[480px] items-center justify-center text-gray-500 dark:text-gray-400">Loading PDF…</div>
                                                }>
                                                    <Page pageNumber={pageView} scale={scale} onRenderSuccess={() => setIsPdfLoading(false)} onRenderError={() => setIsPdfLoading(false)} />
                                                </Document>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </section>

                            <aside>
                                <div className="sticky top-6">
                                    <div className="mb-3 flex items-center justify-between">
                                        <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100">Bookmarks</h2>
                                        <button
                                            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                                            onClick={openAddRoot}
                                            disabled={!file}
                                        >
                                            Add Root Bookmark
                                        </button>
                                    </div>
                                    <div className="h-[520px] overflow-auto rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
                                        {tree.length === 0 ? (
                                            <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">No bookmarks yet</div>
                                        ) : (
                                            <div className="space-y-2">
                                                {tree.map((node) => (
                                                    <BookmarkNode
                                                        key={node.id}
                                                        node={node}
                                                        onAddChild={openAddChild}
                                                        onRemove={removeNode}
                                                        onEdit={openEdit}
                                                        onGo={goToPage}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                        <div className="mt-4 space-y-2">
                                            <button
                                                className={classNames(
                                                    'w-full rounded-md px-3 py-2 text-white',
                                                    canDownload ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-emerald-300 cursor-not-allowed'
                                                )}
                                                onClick={downloadProcessed}
                                                disabled={!canDownload || isProcessing}
                                            >
                                                {isProcessing ? 'Processing…' : 'Download PDF with bookmarks'}
                                            </button>
                                            {tree.length > 0 && (
                                                <button
                                                    className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                                                    onClick={() => setTree([])}
                                                >
                                                    Clear All Bookmarks
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </aside>
                        </>
                    ) : (
                        /* Dummy Tab Content */
                        <div className="lg:col-span-3">
                            <div className="rounded-xl bg-white p-8 shadow-sm ring-1 ring-gray-100 dark:bg-gray-800 dark:ring-gray-700">
                                <div className="text-center">
                                    {/* <div className="mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-indigo-100 text-4xl dark:bg-indigo-900/30">
                                            🎯
                                        </div>
                                        <h2 className="mb-4 text-3xl font-bold text-gray-900 dark:text-white">Photo Upload & Management</h2>
                                        <p className="mb-6 text-lg text-gray-600 dark:text-gray-300">
                                            Select photos from your device and upload them to the server. Perfect for managing your image collection.
                                        </p> */}

                                    {/* Photo Selection & Upload Feature */}
                                    <div className="mb-8">
                                        <div className="text-center mb-8">
                                            <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-indigo-100 to-purple-100 text-4xl dark:from-indigo-900/30 dark:to-purple-900/30">
                                                📸
                                            </div>
                                            <h3 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">Upload & Extract Text</h3>
                                            <p className="text-gray-600 dark:text-gray-300">
                                                Simply upload an image and we'll extract the text for you automatically
                                            </p>
                                        </div>

                                        <div className="mx-auto max-w-4xl">
                                            {/* Upload Area */}
                                            <div className="mb-8">
                                                <label className="group relative block cursor-pointer">
                                                    <div className={classNames(
                                                        'relative overflow-hidden rounded-2xl border-2 border-dashed transition-all duration-200',
                                                        selectedPhoto
                                                            ? 'border-indigo-400 bg-indigo-50/50 dark:border-indigo-500/70 dark:bg-indigo-950/30'
                                                            : 'border-gray-300 bg-gray-50 hover:border-indigo-400 hover:bg-indigo-50/50 dark:border-gray-600 dark:bg-gray-800/50 dark:hover:border-indigo-500 dark:hover:bg-indigo-950/30'
                                                    )}>

                                                        {!selectedPhoto ? (
                                                            <div className="p-12 text-center">
                                                                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/80 text-3xl shadow-sm dark:bg-gray-800/80">
                                                                    📁
                                                                </div>
                                                                <h4 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
                                                                    Choose an image to upload
                                                                </h4>
                                                                <p className="mb-4 text-gray-600 dark:text-gray-300">
                                                                    Drag and drop your image here, or click to browse
                                                                </p>
                                                                <div className="inline-flex items-center gap-2 rounded-full bg-indigo-100 px-4 py-2 text-sm text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                                                                    <span>📱</span>
                                                                    <span>JPG, PNG, GIF, WebP up to 10MB</span>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="p-8 text-center">
                                                                <div className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-white/80 text-4xl shadow-sm dark:bg-gray-800/80">
                                                                    ✅
                                                                </div>
                                                                <h4 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">
                                                                    Image Selected!
                                                                </h4>
                                                                <p className="text-gray-600 dark:text-gray-300">
                                                                    {selectedPhoto.name}
                                                                </p>
                                                                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                                                    Click to change or upload now
                                                                </p>
                                                            </div>
                                                        )}

                                                        <input
                                                            type="file"
                                                            accept="image/*"
                                                            onChange={handlePhotoSelect}
                                                            className="absolute inset-0 w-full cursor-pointer opacity-0"
                                                        />
                                                    </div>
                                                </label>
                                            </div>

                                            {/* Upload Button */}
                                            {selectedPhoto && (
                                                <div className="text-center mb-8">
                                                    <button
                                                        className="group relative inline-flex items-center gap-3 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 px-8 py-4 text-lg font-semibold text-white shadow-lg transition-all duration-200 hover:from-indigo-700 hover:to-purple-700 hover:shadow-xl active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                                                        onClick={async () => {
                                                            try {
                                                                setIsUploading(true);
                                                                const formData = new FormData();
                                                                formData.append('photo', selectedPhoto.file);

                                                                const response = await axios.post(`${BACKEND_BASE_URL}/api/upload-image`, formData);

                                                                if (response.data.success) {
                                                                    showToast('Photo uploaded successfully!', 'info');
                                                                    // Store the uploaded image information
                                                                    setUploadedImage({
                                                                        name: response.data.originalName,
                                                                        uploadedAt: response.data.uploadedAt,
                                                                        fileSize: response.data.fileSize,
                                                                        mimeType: response.data.mimeType,
                                                                        extractedText: response.data.extractedText
                                                                    });
                                                                    // Clear the selection after successful upload
                                                                    setSelectedPhoto(null);
                                                                } else {
                                                                    showToast('Upload failed', 'error');
                                                                }
                                                            } catch (error) {
                                                                console.error('Upload error:', error);
                                                                const errorMessage = error.response?.data?.error || 'Failed to upload photo';
                                                                showToast(errorMessage, 'error');
                                                            } finally {
                                                                setIsUploading(false);
                                                            }
                                                        }}
                                                        disabled={isUploading}
                                                    >
                                                        {isUploading ? (
                                                            <>
                                                                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                                                                <span>Processing Image...</span>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <span>🚀</span>
                                                                <span>Extract Text from Image</span>
                                                            </>
                                                        )}
                                                    </button>

                                                    {isUploading && (
                                                        <div className="mt-4 text-center">
                                                            <p className="text-sm text-gray-600 dark:text-gray-400">
                                                                This may take a few moments for text extraction...
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Uploaded Images Display */}
                                    {uploadedImage && (
                                        <div className="mt-12">
                                            <div className="text-center mb-8">
                                                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-green-100 to-emerald-100 text-3xl dark:from-green-900/30 dark:to-emerald-900/30">
                                                    ✨
                                                </div>
                                                <h3 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">Text Extraction Complete!</h3>
                                                <p className="text-gray-600 dark:text-gray-300">
                                                    Here's the extracted text from your image
                                                </p>
                                            </div>

                                            <div className="mx-auto max-w-4xl">
                                                {/* Extracted Text Display */}
                                                <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                                                    <h4 className="mb-6 text-xl font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                                                        <span>📝</span>
                                                        <span>Extracted Text</span>
                                                    </h4>

                                                    <div className="space-y-6">
                                                        {uploadedImage.extractedText ? (
                                                            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-800 rounded-xl p-6 border">
                                                                <div className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-7 text-left font-sans max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                                                                    {formatExtractedText(uploadedImage.extractedText)}
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-800 rounded-xl p-8 border flex items-center justify-center">
                                                                <div className="text-center">
                                                                    <div className="text-4xl mb-2">❌</div>
                                                                    <p className="text-gray-500 dark:text-gray-400 font-medium">
                                                                        No text could be extracted
                                                                    </p>
                                                                    <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
                                                                        Try a different image with clearer text
                                                                    </p>
                                                                </div>
                                                            </div>
                                                        )}

                                                        {uploadedImage.extractedText && (
                                                            <div className="space-y-4">
                                                                <div className="text-center">
                                                                    <div className="inline-flex items-center gap-2 rounded-full bg-green-100 px-4 py-2 text-sm text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                                                        <span>✅</span>
                                                                        <span>Text extraction completed successfully!</span>
                                                                    </div>
                                                                </div>

                                                                <div className="grid grid-cols-2 gap-4">
                                                                    <button
                                                                        onClick={() => {
                                                                            if (uploadedImage.extractedText) {
                                                                                navigator.clipboard.writeText(uploadedImage.extractedText);
                                                                                showToast('Text copied to clipboard!', 'info');
                                                                            }
                                                                        }}
                                                                        className="rounded-xl bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
                                                                        disabled={!uploadedImage.extractedText}
                                                                    >
                                                                        📋 Copy Text
                                                                    </button>
                                                                    <button
                                                                        onClick={() => {
                                                                            if (uploadedImage.extractedText) {
                                                                                const blob = new Blob([uploadedImage.extractedText], { type: 'text/plain' });
                                                                                const url = URL.createObjectURL(blob);
                                                                                const link = document.createElement('a');
                                                                                link.href = url;
                                                                                link.download = `${uploadedImage.name.replace(/\.[^/.]+$/, '')}_extracted_text.txt`;
                                                                                link.click();
                                                                                URL.revokeObjectURL(url);
                                                                            }
                                                                        }}
                                                                        className="rounded-xl bg-purple-600 px-6 py-3 text-sm font-medium text-white hover:bg-purple-700 dark:bg-purple-500 dark:hover:bg-purple-600 transition-colors flex items-center justify-center gap-2"
                                                                        disabled={!uploadedImage.extractedText}
                                                                    >
                                                                        💾 Save as TXT
                                                                    </button>
                                                                </div>

                                                                <div className="text-center">
                                                                    <button
                                                                        onClick={() => setUploadedImage(null)}
                                                                        className="rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-500 dark:hover:bg-gray-600 transition-colors"
                                                                    >
                                                                        🔄 Process Another Image
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    <div className="mt-8">
                                        <button
                                            onClick={() => setActiveTab('bookmarks')}
                                            className="rounded-md bg-indigo-600 px-6 py-3 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                                        >
                                            📚 Back to Bookmarks
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <Modal
                open={modalOpen}
                title={modalMode === 'edit' ? 'Edit Bookmark' : modalMode === 'addChild' ? 'Add Child Bookmark' : 'Add Root Bookmark'}
                onClose={() => setModalOpen(false)}
                onConfirm={saveModal}
                confirmText={modalMode === 'edit' ? 'Update' : 'Add'}
                confirmDisabled={!formTitle || !formPage}
            >
                <div className="space-y-3">
                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">Title</label>
                        <input
                            autoFocus
                            value={formTitle}
                            onChange={(e) => setFormTitle(e.target.value)}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                            placeholder="Bookmark title"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">Page</label>
                        <input
                            type="number"
                            min={1}
                            max={numPages || undefined}
                            value={formPage}
                            onChange={(e) => setFormPage(e.target.value)}
                            className="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                        />
                        {numPages && (
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">1 – {numPages}</span>
                        )}
                    </div>
                </div>
            </Modal>
        </div>
    );
}
