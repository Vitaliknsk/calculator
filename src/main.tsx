import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

/* ================================================================
   Точка входа + ErrorBoundary.
   Без него любая ошибка в рантайме (в т.ч. специфичная для Safari)
   оставила бы пользователя на пустой белой странице. Теперь вместо
   этого показывается понятный экран с кнопкой перезагрузки.
   ================================================================ */

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            background: "#f1f5ef",
            fontFamily: "'Golos Text', 'Segoe UI', Tahoma, sans-serif",
            color: "#16241e",
          }}
        >
          <div
            style={{
              maxWidth: 440,
              background: "#fff",
              border: "1px solid #dbe5dd",
              borderRadius: 22,
              boxShadow: "0 24px 48px -18px rgb(22 36 30 / 0.24)",
              padding: "32px 28px",
              textAlign: "center",
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 800,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: "#b8433a",
              }}
            >
              Сбой приложения
            </p>
            <h1 style={{ margin: "12px 0 8px", fontSize: 22, fontWeight: 700 }}>Что-то пошло не так</h1>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "#5d6d64" }}>
              Калькулятор не смог запуститься. Попробуйте перезагрузить страницу — сохранённые курсы
              в LocalStorage не потеряются.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                marginTop: 20,
                border: 0,
                borderRadius: 12,
                background: "#0c2e24",
                color: "#fff",
                fontWeight: 700,
                fontSize: 14,
                padding: "12px 22px",
                cursor: "pointer",
              }}
            >
              Перезагрузить страницу
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
