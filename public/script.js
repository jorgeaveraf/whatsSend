document.addEventListener("DOMContentLoaded", () => {
  animateContainer();
  animateLogo();
  loadConfig()
    .then(() => {
      // 2. Cuando ya tenemos la clave, cargamos el QR
      loadQr();
      // 3. Iniciamos el watcher de conexión
      startConnectionWatcher();
    })
    .catch(err => console.error("Error al cargar config:", err));
});

/* ---------------------
   1. Animaciones de entrada
---------------------- */
function animateContainer() {
  const container = document.querySelector(".container");
  container.style.opacity = "0";
  setTimeout(() => {
    container.style.transition = "opacity 1s ease-in-out";
    container.style.opacity = "1";
  }, 300);
}

function animateLogo() {
  const logo = document.querySelector(".logo");
  if (!logo) return;
  logo.style.transform = "translateY(-20px)";
  setTimeout(() => {
    logo.style.transition = "transform 0.8s ease-out";
    logo.style.transform = "translateY(0)";
  }, 500);
}

/* ---------------------
   2. Carga de config
---------------------- */
let ACCESS_KEY = "";

function loadConfig() {
  return fetch("/config")
    .then(res => res.json())
    .then(config => {
      const elem = document.getElementById("companyName");
      if (elem) elem.textContent = config.companyName;
      document.title = "Bienvenido a " + config.companyName;
      ACCESS_KEY = config.accessKey;
    });
}

/* ---------------------
   3. Carga del QR
---------------------- */
function loadQr() {
  fetch("/qr-data", {
    headers: {
      "Authorization": `Bearer ${ACCESS_KEY}`, // 🔑 Enviar clave en el encabezado
    },
  })
    .then(res => res.json())
    .then(data => {
      if (data.status && data.data) {
        const qrDiv = document.getElementById("qrcode");
        const img = document.createElement("img");
        img.src = data.data; // "data:image/png;base64,AAAA..."
        img.style.opacity = "0"; // Para animación fade-in
        qrDiv.appendChild(img);

        setTimeout(() => {
          img.style.transition = "opacity 1s ease-in-out";
          img.style.opacity = "1";
        }, 800);
      } else {
        console.error("No se pudo obtener el QR:", data);
      }
    })
    .catch(err => console.error("Error al obtener el QR:", err));
}


/* ---------------------
   4. Chequeo periódico de conexión
---------------------- */
function startConnectionWatcher() {
  // Llamamos de inmediato y luego repetimos cada 5s
  checkConnectionNow();
  setInterval(() => {
    checkConnectionNow();
  }, 5000);
}

// Consulta /status y, si está conectado, muestra modal
function checkConnectionNow() {
  fetch("/status")
    .then(res => res.json())
    .then(status => {
      if (status.connected) {
        showSuccessModal();
      }
    })
    .catch(err => console.error("Error al chequear conexión:", err));
}

/* ---------------------
   5. Mostrar modal de éxito
---------------------- */
function showSuccessModal() {
  const overlay = document.getElementById("modalOverlay");
  const container = document.getElementById("mainContainer");
  
  // Si el modal ya está en .show, no hagas nada
  if (overlay.classList.contains("show")) return;

  // Muestra el modal y difumina el container
  overlay.classList.add("show");
  container.classList.add("blur");

  // Opcional: Ocultar el QR para impedir reescaneo
  const qrDiv = document.getElementById("qrcode");
  if (qrDiv) qrDiv.style.display = "none";
}
