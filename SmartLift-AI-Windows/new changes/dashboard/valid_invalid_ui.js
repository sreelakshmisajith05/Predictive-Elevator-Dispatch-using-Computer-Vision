/**
 * SmartLift AI — Valid & Invalid Persons Database & Face Recognition UI Integration
 * Isolated in 'new changes/dashboard/valid_invalid_ui.js'
 */

const API_BASE = 'http://localhost:8000';

let currentDatabaseMode = 'VALID'; // 'VALID' or 'INVALID'
let activeEditPersonId = null;
let activeUploadPersonId = null;
let activeFlagCropB64 = null;

// Image Viewer State
let currentZoom = 1.0;
let panX = 0;
let panY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;
let activeViewerFilename = '';
let activeViewerName = '';
let activeViewerPerson = null;

/**
 * Initializes the Database UI components in the Right Panel,
 * creates database modals, image viewer, and unknown-face flagging.
 */
export function initDatabaseUI() {
  injectDatabaseStyles();
  createRightPanelButtons();
  createDatabaseModalDOM();
  createSubModalsDOM();
  createImageViewerModalDOM();
  setupUnknownFaceWatcher();
  enhanceSecurityAlertModal();
}

/** Injects the stylesheet for the new changes */
function injectDatabaseStyles() {
  if (document.getElementById('dbStyles')) return;
  const link = document.createElement('link');
  link.id = 'dbStyles';
  link.rel = 'stylesheet';
  link.href = '/new changes/dashboard/valid_invalid_ui.css';
  document.head.appendChild(link);
}

/** Injects the database options into the Right Panel (no emojis) */
function createRightPanelButtons() {
  // Remove any previous header buttons if present
  const oldHeaderGroup = document.querySelector('.db-header-buttons-group');
  if (oldHeaderGroup) oldHeaderGroup.remove();

  if (document.getElementById('databasesPanelCard')) return;

  const rightPanel = document.querySelector('.panel-right');
  if (!rightPanel) return;

  const card = document.createElement('div');
  card.className = 'dash-card db-panel-card';
  card.id = 'databasesPanelCard';

  card.innerHTML = `
    <div class="db-panel-header">
      <span class="db-panel-title">PERSONNEL DATABASES</span>
    </div>
    <div class="db-panel-actions">
      <button id="btnViewValidDb" class="db-panel-btn valid-db-btn" type="button">
        View Valid Persons Database
      </button>
      <button id="btnViewInvalidDb" class="db-panel-btn invalid-db-btn" type="button">
        View Invalid Persons Database
      </button>
    </div>
  `;

  // Insert right below Hardware Bridge (#hwPanel) or at top of right panel
  const hwPanel = document.getElementById('hwPanel');
  if (hwPanel && hwPanel.nextSibling) {
    rightPanel.insertBefore(card, hwPanel.nextSibling);
  } else {
    rightPanel.prepend(card);
  }

  document.getElementById('btnViewValidDb')?.addEventListener('click', () => openDatabaseModal('VALID'));
  document.getElementById('btnViewInvalidDb')?.addEventListener('click', () => openDatabaseModal('INVALID'));
  updateDatabasePanelCounts();
}

/** Updates live record counts on the right panel database buttons */
export async function updateDatabasePanelCounts() {
  try {
    const res = await fetch(`${API_BASE}/api/face-db/status`);
    if (!res.ok) return;
    const data = await res.json();
    const btnValid = document.getElementById('btnViewValidDb');
    const btnInvalid = document.getElementById('btnViewInvalidDb');
    if (btnValid) btnValid.textContent = `View Valid Persons Database (${data.valid_persons_count ?? 0})`;
    if (btnInvalid) btnInvalid.textContent = `View Invalid Persons Database (${data.invalid_persons_count ?? 0})`;
  } catch (e) {}
}

/** Builds the Fullscreen Database Modal DOM (no emojis) */
function createDatabaseModalDOM() {
  if (document.getElementById('dbModalOverlay')) return;

  const modalHtml = `
    <div id="dbModalOverlay" class="db-modal-overlay hidden">
      <div class="db-modal-window" role="dialog" aria-modal="true">
        <!-- Header (Clean, no emojis) -->
        <div class="db-modal-header">
          <div class="db-title-group">
            <h2 class="db-title-text" id="dbModalTitle">Valid Persons Database</h2>
            <div class="db-subtitle-text" id="dbModalSubtitle">Authorized personnel with verified facial recognition credentials</div>
          </div>
          <div class="db-modal-actions">
            <button id="btnDbAddPerson" class="btn-add-person" type="button">Add Person</button>
            <button id="btnReturnDashboard" class="btn-return-dashboard" type="button">Return to Dashboard</button>
          </div>
        </div>

        <!-- Controls / Search Bar -->
        <div class="db-controls-bar">
          <input type="text" id="dbSearchInput" class="db-search-input" placeholder="Search by name or RFID UID..." />
          <div class="db-stats-badge" id="dbStatsBadge">Loading records...</div>
        </div>

        <!-- Body / Grid -->
        <div class="db-modal-body">
          <div id="dbGrid" class="db-grid">
            <!-- Cards rendered dynamically -->
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // Event Listeners
  document.getElementById('btnReturnDashboard')?.addEventListener('click', closeDatabaseModal);
  document.getElementById('dbModalOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'dbModalOverlay') closeDatabaseModal();
  });
  document.getElementById('btnDbAddPerson')?.addEventListener('click', openAddPersonModal);
  document.getElementById('dbSearchInput')?.addEventListener('input', (e) => {
    filterPersonsGrid(e.target.value);
  });
}

/** Builds Edit, Image Upload, and Unknown Face Flagging Modals (no emojis) */
function createSubModalsDOM() {
  if (document.getElementById('dbSubModalsWrap')) return;

  const subModalsHtml = `
    <div id="dbSubModalsWrap">
      <!-- 1. PERSON EDIT / CREATE MODAL -->
      <div id="editPersonModal" class="db-submodal-overlay hidden">
        <div class="db-submodal-card">
          <div class="db-submodal-title" id="editPersonModalTitle">Edit Person</div>
          <form id="editPersonForm">
            <div class="db-form-row">
              <label>Full Name *</label>
              <input type="text" id="fPersonName" required placeholder="e.g. Abhishek Sri Saai" />
            </div>
            <div class="db-form-row">
              <label>Classification</label>
              <select id="fPersonClass">
                <option value="VALID">VALID (Authorized Passenger)</option>
                <option value="INVALID">INVALID (Restricted / Security Alert)</option>
              </select>
            </div>
            <div class="db-form-row">
              <label>RFID UID (Optional)</label>
              <input type="text" id="fPersonRfid" placeholder="e.g. 69BDF306 (leave blank if unassigned)" />
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px;">
              <button type="button" id="btnCancelEditPerson" class="btn-return-dashboard">Cancel</button>
              <button type="submit" class="btn-add-person">Save Person</button>
            </div>
          </form>
        </div>
      </div>

      <!-- 2. FACE IMAGE UPLOAD MODAL -->
      <div id="uploadImageModal" class="db-submodal-overlay hidden">
        <div class="db-submodal-card">
          <div class="db-submodal-title">Upload Face Reference Image</div>
          <p style="font-size: 12px; color: var(--muted); margin: 0 0 14px 0;">
            Upload a clear face photo. It will be immediately analyzed and enrolled for real-time facial recognition.
          </p>
          <div class="db-dropzone" id="imgDropzone">
            <div style="font-size: 13px; font-weight: 600; color: #fff;">Click or Drag &amp; Drop Photo Here</div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Supports JPG, PNG, WEBP (Max 5 MB)</div>
            <input type="file" id="fImgFileInput" accept="image/jpeg,image/png,image/webp" style="display: none;" />
            <img id="imgUploadPreview" class="db-dropzone-preview hidden" alt="Upload Preview" />
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button type="button" id="btnCancelUploadImg" class="btn-return-dashboard">Cancel</button>
            <button type="button" id="btnConfirmUploadImg" class="btn-add-person" disabled>Upload &amp; Enroll</button>
          </div>
        </div>
      </div>

      <!-- 3. VERIFY NEW FACE MODAL (Dual Valid/Invalid Enrollment) -->
      <div id="flagUnknownModal" class="db-submodal-overlay hidden">
        <div class="db-submodal-card" style="border-color: rgba(245, 158, 11, 0.45);">
          <div class="db-submodal-title" style="color: #f59e0b;" id="verifyModalTitle">Verify New Face</div>
          <p style="font-size: 12px; color: var(--text); line-height: 1.5; margin: 0 0 14px 0;">
            A new face not present in any database was detected on camera. Verify identity and choose database enrollment:
          </p>
          
          <div style="display: flex; align-items: center; gap: 14px; background: var(--panel2); padding: 12px; border-radius: 10px; margin-bottom: 14px; border: 1px solid var(--border);">
            <img id="flagCropPreview" src="" alt="Detected Unknown Face" style="width: 70px; height: 70px; border-radius: 8px; object-fit: cover; border: 2px solid #f59e0b; background: #000;" />
            <div style="flex: 1;">
              <div style="font-size: 11px; font-weight: 700; color: #f59e0b; text-transform: uppercase;">Detected Face Crop</div>
              <div style="font-size: 12px; color: var(--muted); margin-top: 4px;">Live snapshot captured from elevator camera</div>
            </div>
          </div>

          <form id="flagUnknownForm">
            <div class="db-form-row">
              <label>Person Name or Identifier *</label>
              <input type="text" id="fFlagName" required placeholder="e.g. Visitor Name / Employee / Subject" />
            </div>
            <div class="db-form-row">
              <label>Associated RFID UID (Optional)</label>
              <input type="text" id="fFlagRfid" placeholder="e.g. 69BDF306 (leave blank if unassigned)" />
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; flex-wrap: wrap;">
              <button type="button" id="btnCancelFlagUnknown" class="btn-return-dashboard">Cancel</button>
              <button type="button" id="btnVerifyAsValidAction" class="btn-verify-valid-person">Verify as Valid Person</button>
              <button type="button" id="btnFlagAsInvalidAction" class="btn-card-action btn-delete-person" style="padding: 8px 16px; font-weight: 700;">Flag as Invalid Person</button>
            </div>
          </form>
        </div>
      </div>

      <!-- 4. DELETE PERSON SECURITY PASSWORD MODAL -->
      <div id="deletePersonSecurityModal" class="db-submodal-overlay hidden">
        <div class="db-submodal-card" style="border-color: rgba(239, 68, 68, 0.45); max-width: 440px;">
          <div class="db-submodal-title" style="color: #ef4444;">Security Authorization Required</div>
          <p style="font-size: 13px; color: var(--text); line-height: 1.5; margin: 0 0 14px 0;">
            To permanently delete <strong id="deleteTargetPersonName" style="color: #fff;">this record</strong> and their facial recognition profile from the database, enter the administrator security password:
          </p>
          <form id="deletePersonSecurityForm">
            <div class="db-form-row">
              <label style="color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 700;">Security Password *</label>
              <input type="password" id="fDeleteSecurityPassword" placeholder="Enter security password" autocomplete="off" required style="width: 100%; box-sizing: border-box;" />
              <div id="deleteSecurityPasswordError" style="color: #ef4444; font-size: 12px; margin-top: 6px; display: none;"></div>
            </div>
            <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px;">
              <button type="button" id="btnCancelDeletePerson" class="btn-return-dashboard">Cancel</button>
              <button type="submit" id="btnConfirmDeletePerson" class="btn-card-action btn-delete-person" style="padding: 8px 18px; font-weight: 700;">Delete Record</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', subModalsHtml);

  // Sub-modal Event Listeners
  document.getElementById('btnCancelEditPerson')?.addEventListener('click', () => {
    document.getElementById('editPersonModal')?.classList.add('hidden');
  });
  document.getElementById('editPersonForm')?.addEventListener('submit', handleSavePerson);

  document.getElementById('btnCancelUploadImg')?.addEventListener('click', () => {
    document.getElementById('uploadImageModal')?.classList.add('hidden');
  });

  const dropzone = document.getElementById('imgDropzone');
  const fileInput = document.getElementById('fImgFileInput');
  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelected);
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; });
    dropzone.addEventListener('dragleave', () => { dropzone.style.borderColor = 'var(--border2)'; });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--border2)';
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        fileInput.files = e.dataTransfer.files;
        handleFileSelected();
      }
    });
  }

  document.getElementById('btnConfirmUploadImg')?.addEventListener('click', handleUploadImageConfirmed);

  document.getElementById('btnCancelFlagUnknown')?.addEventListener('click', () => {
    document.getElementById('flagUnknownModal')?.classList.add('hidden');
  });
  document.getElementById('btnVerifyAsValidAction')?.addEventListener('click', () => handleVerifyFaceSubmission('VALID'));
  document.getElementById('btnFlagAsInvalidAction')?.addEventListener('click', () => handleVerifyFaceSubmission('INVALID'));
  document.getElementById('flagUnknownForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleVerifyFaceSubmission('VALID');
  });

  document.getElementById('btnCancelDeletePerson')?.addEventListener('click', closeDeletePersonModal);
  document.getElementById('deletePersonSecurityForm')?.addEventListener('submit', handleDeletePersonSubmit);
}

/** Builds the Image Viewer Lightbox Modal (Zoom In, Zoom Out, Pan, Download) */
function createImageViewerModalDOM() {
  if (document.getElementById('dbImageViewerModal')) return;

  const viewerHtml = `
    <div id="dbImageViewerModal" class="db-image-viewer-overlay hidden">
      <!-- Header -->
      <div class="viewer-header">
        <div class="viewer-title-wrap">
          <span class="viewer-person-name" id="viewerPersonName">Person Image</span>
          <span class="badge-classification" id="viewerClassification">VALID</span>
        </div>
        <button id="btnCloseViewer" class="btn-return-dashboard" type="button">Close</button>
      </div>

      <!-- Viewport / Canvas -->
      <div class="viewer-viewport" id="viewerViewport">
        <img id="viewerImg" class="viewer-img" src="" alt="Enrolled Face" />
      </div>

      <!-- Controls Bar -->
      <div class="viewer-controls-bar">
        <button id="btnZoomOut" class="btn-viewer-ctrl" type="button" title="Zoom Out (or scroll down)">Zoom Out (-)</button>
        <span class="zoom-level-badge" id="zoomLevelBadge">100%</span>
        <button id="btnZoomIn" class="btn-viewer-ctrl" type="button" title="Zoom In (or scroll up)">Zoom In (+)</button>
        <button id="btnZoomReset" class="btn-viewer-ctrl" type="button" title="Reset Zoom">Reset</button>
        <button id="btnDownloadViewerImg" class="btn-viewer-ctrl btn-viewer-download" type="button" title="Download original face photo">Download Image</button>
        <button id="btnDeleteViewerImg" class="btn-viewer-ctrl btn-viewer-delete" type="button" title="Delete this person's face photo">Delete Image</button>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', viewerHtml);

  // Viewer Event Listeners
  document.getElementById('btnCloseViewer')?.addEventListener('click', closeImageViewer);
  document.getElementById('btnZoomIn')?.addEventListener('click', () => adjustZoom(0.25));
  document.getElementById('btnZoomOut')?.addEventListener('click', () => adjustZoom(-0.25));
  document.getElementById('btnZoomReset')?.addEventListener('click', resetZoom);
  document.getElementById('btnDownloadViewerImg')?.addEventListener('click', downloadCurrentViewerImage);
  document.getElementById('btnDeleteViewerImg')?.addEventListener('click', () => {
    if (!activeViewerPerson) return;
    openSecurityActionModal('delete_image', activeViewerPerson);
  });

  const viewport = document.getElementById('viewerViewport');
  if (viewport) {
    // Wheel zoom
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.2 : -0.2;
      adjustZoom(delta);
    }, { passive: false });

    // Drag to pan
    viewport.addEventListener('mousedown', (e) => {
      if (e.target.id === 'viewerImg' || e.target.id === 'viewerViewport') {
        isPanning = true;
        startPanX = e.clientX - panX;
        startPanY = e.clientY - panY;
        viewport.classList.add('grabbing');
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      panX = e.clientX - startPanX;
      panY = e.clientY - startPanY;
      applyImageTransform();
    });

    window.addEventListener('mouseup', () => {
      if (isPanning) {
        isPanning = false;
        viewport.classList.remove('grabbing');
      }
    });
  }

  // Close on backdrop click
  document.getElementById('dbImageViewerModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'dbImageViewerModal') closeImageViewer();
  });
}

function openImageViewer(imgUrl, personName, classification, filename, person = null) {
  const viewer = document.getElementById('dbImageViewerModal');
  const imgEl = document.getElementById('viewerImg');
  const nameEl = document.getElementById('viewerPersonName');
  const classEl = document.getElementById('viewerClassification');

  if (!viewer || !imgEl) return;

  activeViewerFilename = filename || 'face_image.jpg';
  activeViewerName = personName || 'person';
  activeViewerPerson = person;

  const btnDelImg = document.getElementById('btnDeleteViewerImg');
  if (btnDelImg) {
    btnDelImg.style.display = activeViewerPerson ? 'inline-flex' : 'none';
  }

  if (nameEl) nameEl.textContent = personName;
  if (classEl) {
    classEl.textContent = classification;
    classEl.className = `badge-classification ${classification.toLowerCase()}`;
  }

  imgEl.src = imgUrl;
  resetZoom();
  viewer.classList.remove('hidden');
}

function closeImageViewer() {
  document.getElementById('dbImageViewerModal')?.classList.add('hidden');
}

function adjustZoom(delta) {
  currentZoom = Math.max(0.5, Math.min(5.0, currentZoom + delta));
  applyImageTransform();
}

function resetZoom() {
  currentZoom = 1.0;
  panX = 0;
  panY = 0;
  applyImageTransform();
}

function applyImageTransform() {
  const imgEl = document.getElementById('viewerImg');
  const badge = document.getElementById('zoomLevelBadge');
  if (imgEl) {
    imgEl.style.transform = `translate(${panX}px, ${panY}px) scale(${currentZoom})`;
  }
  if (badge) {
    badge.textContent = `${Math.round(currentZoom * 100)}%`;
  }
}

function downloadCurrentViewerImage() {
  const imgEl = document.getElementById('viewerImg');
  if (!imgEl || !imgEl.src) return;

  const a = document.createElement('a');
  a.href = imgEl.src;
  const safeName = activeViewerName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  a.download = `person_${safeName}_${activeViewerFilename}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ----------------- Database Modal Navigation -----------------

export function openDatabaseModal(mode = 'VALID') {
  currentDatabaseMode = mode.toUpperCase();
  const overlay = document.getElementById('dbModalOverlay');
  const titleEl = document.getElementById('dbModalTitle');
  const subtitleEl = document.getElementById('dbModalSubtitle');

  if (currentDatabaseMode === 'VALID') {
    if (titleEl) titleEl.textContent = 'Valid Persons Database';
    if (subtitleEl) subtitleEl.textContent = 'Authorized personnel with verified facial recognition credentials';
  } else {
    if (titleEl) titleEl.textContent = 'Invalid Persons Database';
    if (subtitleEl) subtitleEl.textContent = 'Restricted and flagged individuals — detections trigger security alerts';
  }

  if (overlay) overlay.classList.remove('hidden');
  loadDatabaseRecords();
  updateDatabasePanelCounts();
}

export function closeDatabaseModal() {
  const overlay = document.getElementById('dbModalOverlay');
  if (overlay) overlay.classList.add('hidden');
}

let loadedPersonsList = [];

async function loadDatabaseRecords() {
  const grid = document.getElementById('dbGrid');
  const stats = document.getElementById('dbStatsBadge');
  if (grid) grid.innerHTML = '<div style="color: var(--muted); padding: 20px;">Fetching database records...</div>';

  try {
    const res = await fetch(`${API_BASE}/api/face-db/persons?classification=${currentDatabaseMode}`);
    if (!res.ok) throw new Error('Failed to load database records');
    const data = await res.json();
    loadedPersonsList = data.persons || [];
    renderPersonsGrid(loadedPersonsList);
    if (stats) stats.textContent = `${loadedPersonsList.length} ${currentDatabaseMode === 'VALID' ? 'Authorized' : 'Invalid'} Person(s) Registered`;
  } catch (err) {
    if (grid) grid.innerHTML = `<div style="color: var(--danger); padding: 20px;">Error: ${err.message}</div>`;
  }
}

function filterPersonsGrid(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) {
    renderPersonsGrid(loadedPersonsList);
    return;
  }
  const filtered = loadedPersonsList.filter(p => 
    p.name.toLowerCase().includes(q) || (p.rfid_uid && p.rfid_uid.toLowerCase().includes(q))
  );
  renderPersonsGrid(filtered);
}

function renderPersonsGrid(persons) {
  const grid = document.getElementById('dbGrid');
  if (!grid) return;

  if (!persons.length) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--muted);">
        <div style="font-size: 14px; font-weight: 600;">No records found in ${currentDatabaseMode} Database.</div>
        <div style="font-size: 12px; margin-top: 4px;">Click "Add Person" to create a new profile.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = '';
  persons.forEach(p => {
    const card = document.createElement('div');
    card.className = `person-card ${p.classification.toLowerCase()}-card`;

    // Face image or placeholder (No emojis)
    const hasImg = p.has_image && p.image_filename;
    const imgUrl = hasImg ? `${API_BASE}/api/face-db/images/${p.image_filename}?t=${Date.now()}` : '';

    const imageHtml = hasImg
      ? `<img src="${imgUrl}" class="face-avatar-img" alt="${p.name}" />`
      : `<div class="face-avatar-placeholder">
           <span class="placeholder-lbl">Image not uploaded</span>
         </div>`;

    const rfidHtml = p.rfid_uid
      ? `<span class="badge-rfid" title="Configured RFID Tag">RFID: ${p.rfid_uid}</span>`
      : `<span class="badge-rfid none">RFID: Not configured</span>`;

    card.innerHTML = `
      <div class="person-card-top">
        <div class="face-avatar-wrap ${hasImg ? 'clickable' : ''}" title="${hasImg ? 'Click to zoom in/out or download' : 'No photo uploaded'}">
          ${imageHtml}
        </div>
        <div class="person-info">
          <h3 class="person-name" title="${p.name}">${p.name}</h3>
          <div class="person-badges">
            <span class="badge-classification ${p.classification.toLowerCase()}">${p.classification}</span>
            ${rfidHtml}
          </div>
        </div>
      </div>
      <div class="person-actions-bar">
        <button class="btn-card-action btn-upload-face" type="button" data-id="${p.id}" title="Upload or replace reference face image">
          ${p.has_image ? 'Replace Image' : 'Upload Image'}
        </button>
        <button class="btn-card-action btn-edit-person" type="button" data-id="${p.id}" title="Edit Name & RFID UID">
          Edit
        </button>
        <button class="btn-card-action btn-delete-person" type="button" data-id="${p.id}" data-name="${p.name}" title="Delete person and associated files">
          Delete
        </button>
      </div>
    `;

    // Click on avatar to open image viewer lightbox (Zoom / Download / Delete Image)
    if (hasImg) {
      card.querySelector('.face-avatar-wrap').addEventListener('click', () => {
        openImageViewer(imgUrl, p.name, p.classification, p.image_filename, p);
      });
    }

    // Action button listeners - ALL password protected (Replace Image, Edit, Delete)
    card.querySelector('.btn-upload-face').addEventListener('click', () => openSecurityActionModal('upload', p));
    card.querySelector('.btn-edit-person').addEventListener('click', () => openSecurityActionModal('edit', p));
    card.querySelector('.btn-delete-person').addEventListener('click', () => openSecurityActionModal('delete', p));

    grid.appendChild(card);
  });
}

// ----------------- CRUD Operations -----------------

function openAddPersonModal() {
  activeEditPersonId = null;
  const title = document.getElementById('editPersonModalTitle');
  if (title) title.textContent = `Add Person to ${currentDatabaseMode} Database`;
  document.getElementById('fPersonName').value = '';
  document.getElementById('fPersonClass').value = currentDatabaseMode;
  document.getElementById('fPersonRfid').value = '';
  document.getElementById('editPersonModal')?.classList.remove('hidden');
}

function openEditPersonModal(person) {
  activeEditPersonId = person.id;
  const title = document.getElementById('editPersonModalTitle');
  if (title) title.textContent = `Edit Person (${person.name})`;
  document.getElementById('fPersonName').value = person.name;
  document.getElementById('fPersonClass').value = person.classification;
  document.getElementById('fPersonRfid').value = person.rfid_uid || '';
  document.getElementById('editPersonModal')?.classList.remove('hidden');
}

async function handleSavePerson(e) {
  e.preventDefault();
  const name = document.getElementById('fPersonName').value.trim();
  const classification = document.getElementById('fPersonClass').value;
  const rfid_uid = document.getElementById('fPersonRfid').value.trim() || null;

  try {
    let res;
    if (activeEditPersonId) {
      res = await fetch(`${API_BASE}/api/face-db/persons/${activeEditPersonId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, classification, rfid_uid }),
      });
    } else {
      res = await fetch(`${API_BASE}/api/face-db/persons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, classification, rfid_uid }),
      });
    }

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Save failed');
    }

    document.getElementById('editPersonModal')?.classList.add('hidden');

    // Automatically switch database view if classification was updated so changes are immediately visible
    if (classification && classification.toUpperCase() !== currentDatabaseMode) {
      currentDatabaseMode = classification.toUpperCase();
      const titleEl = document.getElementById('dbModalTitle');
      const subtitleEl = document.getElementById('dbModalSubtitle');
      if (currentDatabaseMode === 'VALID') {
        if (titleEl) titleEl.textContent = 'Valid Persons Database';
        if (subtitleEl) subtitleEl.textContent = 'Authorized personnel with verified facial recognition credentials';
      } else {
        if (titleEl) titleEl.textContent = 'Invalid Persons Database';
        if (subtitleEl) subtitleEl.textContent = 'Restricted and flagged individuals — detections trigger security alerts';
      }
    }

    showNotification(`Saved "${name}" as ${classification === 'VALID' ? 'Valid (Authorized)' : 'Invalid (Restricted)'} Person.`);
    loadDatabaseRecords();
    updateDatabasePanelCounts();
  } catch (err) {
    alert(`Could not save person: ${err.message}`);
  }
}

// ----------------- Password-Protected Action Handling (Delete, Edit, Replace Image) -----------------

let pendingSecurityAction = null; // 'delete' | 'edit' | 'upload'
let pendingSecurityPerson = null;
let pendingDeletePersonId = null;
let pendingDeletePersonName = '';

function openSecurityActionModal(action, person) {
  pendingSecurityAction = action;
  pendingSecurityPerson = person;
  pendingDeletePersonId = person.id;
  pendingDeletePersonName = person.name;

  const modalEl = document.getElementById('deletePersonSecurityModal');
  const titleEl = modalEl?.querySelector('.db-submodal-title');
  const cardEl = modalEl?.querySelector('.db-submodal-card');
  const descEl = modalEl?.querySelector('p');
  const submitBtn = document.getElementById('btnConfirmDeletePerson');
  const pwInput = document.getElementById('fDeleteSecurityPassword');
  const errEl = document.getElementById('deleteSecurityPasswordError');

  if (titleEl) {
    if (action === 'delete') {
      titleEl.textContent = 'Security Authorization Required (Delete Record)';
      titleEl.style.color = '#ef4444';
    } else if (action === 'delete_image') {
      titleEl.textContent = 'Security Authorization Required (Delete Image)';
      titleEl.style.color = '#ef4444';
    } else if (action === 'edit') {
      titleEl.textContent = 'Security Authorization Required (Edit Record)';
      titleEl.style.color = '#60a5fa';
    } else if (action === 'upload') {
      titleEl.textContent = 'Security Authorization Required (Replace Image)';
      titleEl.style.color = '#60a5fa';
    }
  }

  if (cardEl) {
    if (action === 'delete' || action === 'delete_image') {
      cardEl.style.borderColor = 'rgba(239, 68, 68, 0.45)';
    } else {
      cardEl.style.borderColor = 'rgba(96, 165, 250, 0.45)';
    }
  }

  if (descEl) {
    if (action === 'delete') {
      descEl.innerHTML = `To permanently delete <strong id="deleteTargetPersonName" style="color: #fff;">"${person.name}"</strong> and their facial recognition profile from the database, enter the administrator security password:`;
    } else if (action === 'delete_image') {
      descEl.innerHTML = `To remove the reference face image for <strong id="deleteTargetPersonName" style="color: #fff;">"${person.name}"</strong>, enter the administrator security password:`;
    } else if (action === 'edit') {
      descEl.innerHTML = `To edit details for <strong id="deleteTargetPersonName" style="color: #fff;">"${person.name}"</strong> in the database, enter the administrator security password:`;
    } else if (action === 'upload') {
      descEl.innerHTML = `To replace or upload the reference face image for <strong id="deleteTargetPersonName" style="color: #fff;">"${person.name}"</strong>, enter the administrator security password:`;
    }
  }

  if (submitBtn) {
    if (action === 'delete') {
      submitBtn.textContent = 'Delete Record';
      submitBtn.className = 'btn-card-action btn-delete-person';
      submitBtn.style.padding = '8px 18px';
      submitBtn.style.fontWeight = '700';
    } else if (action === 'delete_image') {
      submitBtn.textContent = 'Delete Image';
      submitBtn.className = 'btn-card-action btn-delete-person';
      submitBtn.style.padding = '8px 18px';
      submitBtn.style.fontWeight = '700';
    } else if (action === 'edit') {
      submitBtn.textContent = 'Continue to Edit';
      submitBtn.className = 'btn-verify-valid-person';
      submitBtn.style.padding = '8px 18px';
      submitBtn.style.fontWeight = '700';
    } else if (action === 'upload') {
      submitBtn.textContent = 'Continue to Replace Image';
      submitBtn.className = 'btn-verify-valid-person';
      submitBtn.style.padding = '8px 18px';
      submitBtn.style.fontWeight = '700';
    }
  }

  if (pwInput) pwInput.value = '';
  if (errEl) {
    errEl.textContent = '';
    errEl.style.display = 'none';
  }

  modalEl?.classList.remove('hidden');
  setTimeout(() => pwInput?.focus(), 60);
}

function openDeletePersonModal(personId, personName) {
  openSecurityActionModal('delete', { id: personId, name: personName });
}

function closeDeletePersonModal() {
  document.getElementById('deletePersonSecurityModal')?.classList.add('hidden');
  pendingDeletePersonId = null;
  pendingDeletePersonName = '';
  pendingSecurityAction = null;
  pendingSecurityPerson = null;
}

async function handleDeletePersonSubmit(e) {
  if (e) e.preventDefault();
  if (!pendingSecurityPerson) return;

  const pwInput = document.getElementById('fDeleteSecurityPassword');
  const enteredPassword = (pwInput?.value || '').trim();
  const errEl = document.getElementById('deleteSecurityPasswordError');

  if (!enteredPassword) {
    if (errEl) {
      errEl.textContent = 'Please enter the security password.';
      errEl.style.display = 'block';
    }
    return;
  }

  if (enteredPassword !== 'xyz123') {
    if (errEl) {
      errEl.textContent = 'Incorrect security password. Access unauthorized.';
      errEl.style.display = 'block';
    }
    if (pwInput) pwInput.select();
    return;
  }

  const action = pendingSecurityAction;
  const person = pendingSecurityPerson;

  if (action === 'edit') {
    closeDeletePersonModal();
    openEditPersonModal(person);
    return;
  }

  if (action === 'upload') {
    closeDeletePersonModal();
    openUploadImageModal(person.id);
    return;
  }

  if (action === 'delete_image') {
    const submitBtn = document.getElementById('btnConfirmDeletePerson');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Deleting Image...';
    }

    try {
      const res = await fetch(`${API_BASE}/api/face-db/persons/${person.id}/image?password=${encodeURIComponent(enteredPassword)}`, {
        method: 'DELETE',
        headers: {
          'X-Security-Password': enteredPassword
        }
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Image deletion failed');
      }

      closeDeletePersonModal();
      closeImageViewer();
      showNotification(`Deleted face image for "${person.name}".`);
      loadDatabaseRecords();
      updateDatabasePanelCounts();
    } catch (err) {
      if (errEl) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      } else {
        alert(`Error deleting image: ${err.message}`);
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Delete Image';
      }
    }
    return;
  }

  // Deletion logic
  const submitBtn = document.getElementById('btnConfirmDeletePerson');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Deleting...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/face-db/persons/${pendingDeletePersonId}?password=${encodeURIComponent(enteredPassword)}`, {
      method: 'DELETE',
      headers: {
        'X-Security-Password': enteredPassword
      }
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || 'Deletion failed');
    }

    const deletedName = pendingDeletePersonName;
    closeDeletePersonModal();
    showNotification(`Deleted "${deletedName}" and associated face references.`);
    loadDatabaseRecords();
    updateDatabasePanelCounts();
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } else {
      alert(`Error deleting person: ${err.message}`);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Delete Record';
    }
  }
}

function confirmDeletePerson(personId, personName) {
  openSecurityActionModal('delete', { id: personId, name: personName });
}

// ----------------- Face Image Upload Handling -----------------

let selectedImageBase64 = null;

function openUploadImageModal(personId) {
  activeUploadPersonId = personId;
  selectedImageBase64 = null;
  const fileInput = document.getElementById('fImgFileInput');
  if (fileInput) fileInput.value = '';
  const preview = document.getElementById('imgUploadPreview');
  if (preview) {
    preview.src = '';
    preview.classList.add('hidden');
  }
  const confirmBtn = document.getElementById('btnConfirmUploadImg');
  if (confirmBtn) confirmBtn.disabled = true;
  document.getElementById('uploadImageModal')?.classList.remove('hidden');
}

function handleFileSelected() {
  const fileInput = document.getElementById('fImgFileInput');
  const confirmBtn = document.getElementById('btnConfirmUploadImg');
  const preview = document.getElementById('imgUploadPreview');

  if (!fileInput.files || !fileInput.files[0]) return;
  const file = fileInput.files[0];

  if (file.size > 5 * 1024 * 1024) {
    alert('Selected image exceeds the 5 MB size limit. Please choose a smaller photo.');
    fileInput.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    selectedImageBase64 = e.target.result;
    if (preview) {
      preview.src = selectedImageBase64;
      preview.classList.remove('hidden');
    }
    if (confirmBtn) confirmBtn.disabled = false;
  };
  reader.readAsDataURL(file);
}

async function handleUploadImageConfirmed() {
  if (!activeUploadPersonId || !selectedImageBase64) return;
  const confirmBtn = document.getElementById('btnConfirmUploadImg');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Enrolling...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/face-db/persons/${activeUploadPersonId}/image-base64`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: selectedImageBase64, filename: 'upload.jpg' }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Upload failed');
    }

    document.getElementById('uploadImageModal')?.classList.add('hidden');
    showNotification('Face image uploaded and enrolled for recognition!');
    loadDatabaseRecords();
  } catch (err) {
    alert(`Upload error: ${err.message}`);
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Upload & Enroll';
    }
  }
}

// ----------------- Real-Time Face Recognition HUD & Verification -----------------

function setupUnknownFaceWatcher() {
  // Polls backend every 1.0s for real-time face detection & identity status
  setInterval(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/face-db/latest-face`);
      if (!res.ok) return;
      const data = await res.json();
      updateUnknownFaceBanner(data);
    } catch (e) {}
  }, 1000);
}

let lastBannerSignature = '';
const dismissedAlertIds = new Set();
let activeDisplayedAlertEventId = null;

function updateUnknownFaceBanner(data) {
  const cameraBox = document.querySelector('.camera-input') || document.querySelector('.camera-box') || document.querySelector('.panel-box:has(#camVideo)');
  let banner = document.getElementById('unknownFaceBanner');

  const facesList = (data.faces && data.faces.length > 0)
    ? data.faces
    : ((data.has_recent_face && data.crop_b64) ? [data] : []);

  if (facesList.length > 0) {
    if (facesList[0].crop_b64) {
      activeFlagCropB64 = facesList[0].crop_b64;
    }
    const currentSignature = facesList
      .map((f, i) => `${f.face_status}_${f.person ? (f.person.id || f.person.name) : 'unknown'}_${f.crop_b64 ? f.crop_b64.slice(0, 16) : i}`)
      .join('|');

    if (!banner && cameraBox) {
      banner = document.createElement('div');
      banner.id = 'unknownFaceBanner';
      banner.className = 'unknown-face-banner';
      // Insert right after the video element if available
      const videoEl = cameraBox.querySelector('video') || cameraBox.querySelector('#camVideo');
      if (videoEl && videoEl.nextSibling) {
        cameraBox.insertBefore(banner, videoEl.nextSibling);
      } else {
        cameraBox.appendChild(banner);
      }
    }

    if (banner) {
      // Rebuild inner DOM when the face signature changes (prevents thrashing/jitter)
      if (currentSignature !== lastBannerSignature) {
        lastBannerSignature = currentSignature;

        let cardsHtml = '';
        facesList.forEach((face, idx) => {
          const cropSrc = face.crop_b64 ? `data:image/jpeg;base64,${face.crop_b64}` : '';
          const person = face.person;

          if (face.face_status === 'MATCH_VALID' && person) {
            cardsHtml += `
              <div class="face-hud-card face-hud-valid">
                <div class="unknown-banner-left">
                  ${cropSrc ? `<img src="${cropSrc}" class="unknown-banner-crop crop-valid" alt="Valid Face" />` : ''}
                  <div>
                    <div class="face-hud-badge-tag tag-valid">VALID PERSON IDENTIFIED</div>
                    <div class="unknown-banner-text">${person.name}</div>
                    <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">
                      Registered RFID: <code>${person.rfid_uid || 'Unassigned'}</code> · Ready for card cross-check
                    </div>
                  </div>
                </div>
              </div>
            `;
          } else if (face.face_status === 'MATCH_INVALID' && person) {
            cardsHtml += `
              <div class="face-hud-card face-hud-invalid">
                <div class="unknown-banner-left">
                  ${cropSrc ? `<img src="${cropSrc}" class="unknown-banner-crop crop-invalid" alt="Invalid Face" />` : ''}
                  <div>
                    <div class="face-hud-badge-tag tag-invalid">SECURITY ALERT: INVALID PERSON</div>
                    <div class="unknown-banner-text" style="color: #ef4444;">${person.name}</div>
                    <div style="font-size: 10px; color: #f87171; margin-top: 2px;">
                      Restricted Subject · Access Prohibited Regardless of RFID
                    </div>
                  </div>
                </div>
              </div>
            `;
          } else {
            // New / Unknown Face Detected
            cardsHtml += `
              <div class="face-hud-card face-hud-unknown">
                <div class="unknown-banner-left">
                  ${cropSrc ? `<img src="${cropSrc}" class="unknown-banner-crop crop-unknown" alt="New Face" />` : ''}
                  <div>
                    <div class="face-hud-badge-tag tag-unknown">NEW FACE DETECTED</div>
                    <div class="unknown-banner-text">New Face: Please Verify</div>
                    <div style="font-size: 10px; color: var(--muted); margin-top: 2px;">Subject not present in any database</div>
                  </div>
                </div>
                <button class="btn-verify-new-face btn-verify-person-action" data-face-idx="${idx}" type="button">Verify Face</button>
              </div>
            `;
          }
        });

        banner.innerHTML = cardsHtml;

        // Bind Verify Face buttons for each detected individual
        banner.querySelectorAll('.btn-verify-person-action').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-face-idx'), 10);
            const targetFace = facesList[idx];
            if (targetFace && targetFace.crop_b64) {
              openFlagUnknownModal(targetFace.crop_b64);
            } else {
              openFlagUnknownModal(activeFlagCropB64);
            }
          });
        });
      }
      banner.classList.remove('hidden');
    }
  } else {
    lastBannerSignature = 'NONE';
    if (banner) banner.classList.add('hidden');
  }
}

function openFlagUnknownModal(cropB64) {
  activeFlagCropB64 = cropB64;
  const preview = document.getElementById('flagCropPreview');
  if (preview && cropB64) {
    preview.src = `data:image/jpeg;base64,${cropB64}`;
  }
  const now = new Date();
  const defaultName = `New Subject (${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')})`;
  const nameInput = document.getElementById('fFlagName');
  if (nameInput) nameInput.value = defaultName;
  const rfidInput = document.getElementById('fFlagRfid');
  if (rfidInput) rfidInput.value = '';
  document.getElementById('flagUnknownModal')?.classList.remove('hidden');
}

async function handleVerifyFaceSubmission(classification = 'VALID') {
  const nameInput = document.getElementById('fFlagName');
  const rfidInput = document.getElementById('fFlagRfid');
  const name = (nameInput ? nameInput.value : '').trim();
  const rfid_uid = (rfidInput ? rfidInput.value : '').trim() || null;

  if (!name) {
    alert('Please enter a person name or identifier.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/face-db/verify-face`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        classification,
        crop_b64: activeFlagCropB64,
        rfid_uid
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Verification failed');
    }

    document.getElementById('flagUnknownModal')?.classList.add('hidden');
    const banner = document.getElementById('unknownFaceBanner');
    if (banner) banner.classList.add('hidden');
    lastBannerSignature = 'NONE';

    const classLabel = classification === 'VALID' ? 'Valid (Authorized)' : 'Invalid (Restricted)';
    showNotification(`Successfully verified & enrolled "${name}" as ${classLabel} Person.`);
    if (!document.getElementById('dbModalOverlay')?.classList.contains('hidden')) {
      loadDatabaseRecords();
    }
    updateDatabasePanelCounts();
  } catch (err) {
    alert(`Could not verify person: ${err.message}`);
  }
}

// ----------------- Security Alert Modal Enhancements -----------------

function enhanceSecurityAlertModal() {
  const modal = document.getElementById('secAlertModal');
  if (!modal || modal.dataset.enhanced) return;
  modal.dataset.enhanced = 'true';

  // Inject detail container into existing security alert modal
  const msgEl = document.getElementById('secAlertMsg');
  const detailsWrap = document.createElement('div');
  detailsWrap.id = 'secAlertExtendedDetails';
  detailsWrap.style.margin = '10px 0';
  if (msgEl) {
    msgEl.parentNode.insertBefore(detailsWrap, msgEl.nextSibling);
  }

  // Intercept dismiss events so the dismissed alert does not pop back open
  const btnDismiss = document.getElementById('btnDismissSecAlert');
  if (btnDismiss) {
    btnDismiss.addEventListener('click', () => {
      if (activeDisplayedAlertEventId) {
        dismissedAlertIds.add(activeDisplayedAlertEventId);
      }
      modal.classList.add('hidden');
    });
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      if (activeDisplayedAlertEventId) {
        dismissedAlertIds.add(activeDisplayedAlertEventId);
      }
      modal.classList.add('hidden');
    }
  });

  // Intercept window event or polling to format enriched alerts
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';

    if (url.includes('/security/events')) {
      const clone = response.clone();
      clone.json().then(data => {
        if (data && data.events && data.events.length) {
          const latest = data.events[0];
          const isFresh = (Date.now() / 1000 - (latest.at || 0)) < 4.0;
          if (isFresh && latest.status !== 'ACCESS_GRANTED') {
            renderEnhancedAlertDetails(latest);
          }
        }
      }).catch(() => {});
    }
    return response;
  };
}

function renderEnhancedAlertDetails(ev) {
  const wrap = document.getElementById('secAlertExtendedDetails');
  const msgEl = document.getElementById('secAlertMsg');
  const modal = document.getElementById('secAlertModal');

  // If this alert was already dismissed by the operator, DO NOT re-open the modal!
  if (ev.event_id && dismissedAlertIds.has(ev.event_id)) {
    return;
  }

  activeDisplayedAlertEventId = ev.event_id || null;

  if (msgEl && ev.message) {
    msgEl.textContent = ev.message;
  }

  if (modal && ev.status === 'ACCESS_DENIED') {
    modal.classList.remove('hidden');
  }

  if (!wrap) return;

  const reason = ev.reason || 'Invalid RFID';
  const confidence = ev.face_match_confidence ? `${(ev.face_match_confidence * 100).toFixed(1)}%` : null;

  wrap.innerHTML = `
    <div class="sec-alert-badge-row">
      <span class="sec-alert-pill">Reason: ${reason}</span>
      ${ev.expected_uid ? `<span class="sec-alert-pill" style="border-color: #10b981; color: #10b981;">Expected: ${ev.expected_uid}</span>` : ''}
      ${ev.uid && ev.uid !== 'N/A' ? `<span class="sec-alert-pill" style="border-color: #ef4444; color: #ef4444;">Scanned: ${ev.uid}</span>` : ''}
      ${confidence ? `<span class="sec-alert-pill pill-conf">Face Match: ${confidence}</span>` : ''}
    </div>
    ${ev.crop_file ? `
      <div style="font-size: 11px; font-weight: 700; color: var(--muted); margin-bottom: 6px;">Detected Subject Crop:</div>
      <img src="${API_BASE}/security/image/${ev.event_id}" style="width: 80px; height: 80px; border-radius: 8px; object-fit: cover; border: 2px solid var(--danger); margin: 0 auto 10px auto; display: block;" alt="Subject Crop" />
    ` : ''}
  `;
}

function showNotification(msg) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }
}
