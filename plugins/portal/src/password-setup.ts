import { createHash } from "node:crypto";
export const PASSWORD_SETUP_SCRIPT = `(()=>{const params=new URLSearchParams(location.hash.slice(1));const token=params.get("token");if(token){document.getElementById("password-token").value=token;history.replaceState(null,"",location.pathname);} })();`;
export const PASSWORD_SETUP_SCRIPT_HASH = `sha256-${createHash("sha256").update(PASSWORD_SETUP_SCRIPT).digest("base64")}`;
