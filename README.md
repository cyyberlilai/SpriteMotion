# SpriteMotion

🚀 **Live Demo:** [https://spritemotion.framesecond.uk/](https://spritemotion.framesecond.uk/)

SpriteMotion is a powerful, browser-based tool built with React and Vite for processing, analyzing, and animating sprite sheets. Designed for game developers and digital artists, it allows you to easily slice sprite sheets into individual frames, apply smart transparency, align sprites, and export them as animated GIFs or individual image sequences.

## 🚀 Features

- **Sprite Sheet Slicing:** Easily configure rows, columns, and total frames to slice any sprite sheet accurately.
- **Smart Background Removal:** Features flood-fill transparency with adjustable color tolerance to remove backgrounds while preserving the inner colors of your sprites.
- **Auto-Alignment:** Automatically calculate bounding boxes to align sprites to the center or bottom of the frame, ensuring smooth animations without jitter.
- **Customizable Playback:** Adjust the FPS and preview your animation in real-time.
- **Advanced Cropping & Scaling:** Crop the sprite sheet before processing and scale the final output. Option to clamp max resolution to 1024px.
- **Frame Management:** Exclude specific frames and choose the read order (Row-major or Column-major).
- **AI Analysis:** Integration with Gemini AI (`@google/genai`) to intelligently analyze sprite sheets and suggest optimal slicing configurations.
- **Multiple Export Options:** Export your processed sprites as a combined animated GIF or download individual frames as a ZIP.

## 🛠 Tech Stack

- **Frontend Framework:** React 19
- **Build Tool:** Vite 6
- **Language:** TypeScript
- **Icons:** Lucide React
- **AI Integration:** Google Gemini API (`@google/genai`)

## 💻 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed.

### Installation

1. Navigate to the project directory:
   ```bash
   cd SpriteMotion
   ```

2. Install the dependencies:
   ```bash
   npm install
   ```

3. **(Optional)** Configure the AI analysis feature (the "自动识别" / auto-detect button).
   You can either fill in your key directly in the browser — click the **「AI 设置」** button in the top-right corner — or pre-set it for all users of this build via `.env.local`.

   **Option A — fill in the browser (recommended for personal use):**
   Click 「AI 设置」 in the header, pick a provider, and paste your API key. The key is stored in your browser's `localStorage` only — it never goes to any third-party server, and is sent directly to the chosen provider when you click 「自动识别」.

   **JSON 模式 toggle:** sends `response_format: {"type":"json_object"}` to make the model return JSON directly. Some Coding Plan endpoints reject this parameter — if that happens the app automatically retries without it, so you usually don't need to touch this.

   **Option B — pre-set via `.env.local` (for shared/deployed builds):**
   ```bash
   cp .env.example .env.local
   ```
   Any **OpenAI-compatible** endpoint works. Built-in presets:

   | `VITE_AI_PROVIDER` | Provider | Key env var | Default model |
   |---|---|---|---|
   | `gemini` | Google Gemini | `VITE_GEMINI_API_KEY` | `gemini-2.5-flash` |
   | `openai` | OpenAI | `VITE_OPENAI_API_KEY` | `gpt-4o-mini` |
   | `custom` | Any compatible endpoint | `VITE_AI_API_KEY` | you provide it |

   Example — switch to OpenAI:
   ```env
   VITE_AI_PROVIDER=openai
   VITE_OPENAI_API_KEY=your_key
   ```
   You can also use `VITE_AI_API_KEY` universally and override the endpoint/model with `VITE_AI_BASE_URL` / `VITE_AI_MODEL`. If `VITE_AI_PROVIDER` is omitted, the provider is inferred from whichever key is present.

   > Note: changes to `.env` require **restarting the dev server**. A key entered in the browser takes priority over the `.env.local` one.

4. Start the development server:
   ```bash
   npm run dev
   ```

5. Open your browser and navigate to the local URL provided by Vite (usually `http://localhost:3000`).

## 🎮 How to Use

1. **Upload:** Click the upload area to load your sprite sheet image (PNG, JPG, etc.).
2. **Analyze (Optional):** Click the "Sparkles" AI button to have Gemini automatically guess the rows and columns.
3. **Configure Settings:**
   - Adjust Rows and Columns to match your grid.
   - Set the Transparency color and adjust the Tolerance/Flood Fill settings to remove solid backgrounds.
   - Toggle Auto Align if your sprites have different sizes within their grid cells.
4. **Preview:** Watch the `PreviewPlayer` to see how your animation looks. Adjust the FPS as needed.
5. **Export:** 
   - Click **Export GIF** to generate and download an animated `.gif`.
   - Click **Export Frames** to download all the processed frames in a `.zip` file.

## 📝 Scripts

- `npm run dev`: Starts the local development server.
- `npm run build`: Builds the app for production to the `dist` folder.
- `npm run preview`: Previews the production build locally.
