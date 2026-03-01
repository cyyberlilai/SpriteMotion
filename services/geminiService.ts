import { GoogleGenAI, Type } from "@google/genai";
import { SpriteConfig } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeSpriteSheet = async (base64Image: string): Promise<Partial<SpriteConfig>> => {
  try {
    // Clean base64 string if it has the prefix
    const cleanBase64 = base64Image.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, "");

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: cleanBase64
            }
          },
          {
            text: `Analyze this sprite sheet image. It contains a sequence of animation frames arranged in a grid.
            Count the number of rows and columns. 
            Also estimate the total number of valid frames (sometimes the last row is not full).
            Return the result in JSON format.`
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            rows: { type: Type.INTEGER, description: "Number of rows in the grid" },
            cols: { type: Type.INTEGER, description: "Number of columns in the grid" },
            totalFrames: { type: Type.INTEGER, description: "Total actual frames (sprites) in the image" },
          },
          required: ["rows", "cols", "totalFrames"],
        }
      }
    });

    if (response.text) {
      const data = JSON.parse(response.text);
      return {
        rows: data.rows,
        cols: data.cols,
        totalFrames: data.totalFrames
      };
    }
    throw new Error("No response text from Gemini");

  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    throw error;
  }
};
