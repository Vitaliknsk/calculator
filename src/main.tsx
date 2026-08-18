import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

/* ------------------------------------------------------------------
   Предохранитель приложения: если где-то в дереве React случится
   ошибка, пользователь увидит понятное сообщение с кнопкой
   перезагрузки, а не «белый экран смерти».
   ------------------------------------------------------------------ */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Ошибка приложения:", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f1f5ef",
            fontFamily: '"Golos Text", "Segoe UI", Tahoma, sans-serif',
            padding: "24px",
          }}
        >
          <div
            style={{
              background: "#fff",
              border: "1px solid #dbe5dd",
              borderRadius: "20px",
              boxShadow: "0 20px 50px -20px rgba(22,36,30,0.25)",
              padding: "32px",
              maxWidth: "460px",
              textAlign: "center",
              color: "#16241e",
            }}
          >
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "1.15rem",
                fontWeight: 700,
              }}
            >
              Что-то пошло не так
            </p>
            <p style={{ margin: "0 0 20px", fontSize: "0.88rem", color: "#5d6d64" }}>
              Калькулятор столкнулся с непредвиденной ошибкой. Попробуйте перезагрузить
              страницу — курсы из LocalStorage при этом не потеряются.
            </p>
            <button
              onClick={() => window.location.reload()}
              style={{
                border: "none",
                borderRadius: "12px",
                background: "#175241",
                color: "#fff",
                padding: "12px 28px",
                fontSize: "0.9rem",
                fontWeight: 700,
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

const rootElement = document.getElementById("root");

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
} else {
  // Совсем экзотический случай: в документе нет корневого контейнера
  document.body.textContent = "Не найден элемент #root — страница повреждена.";
}
