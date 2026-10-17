/**
 * WebGL2 GLSL Shaders for the Physical Loom Transmittance Accumulator & Screen Pass.
 *
 * Conforms to ADR-002:
 * 1. Accumulation Pass: Linear-light RGB (gamma=1.0) optical accumulation on RGBA16F FBO,
 *    sub-pixel cylindrical thread profile with analytical antialiasing.
 * 2. Screen Pass: Linear-to-sRGB IEC 61966-2-1 tone mapping, subtle directional fiber sheen,
 *    physical loom hoop frame and metallic cylindrical pegs with specular highlights.
 */

export const ACCUMULATION_VS = `#version 300 es
precision highp float;

// Unit quad vertex coordinates: x in [0.0, 1.0] along chord, y in [-1.0, 1.0] across chord
layout(location = 0) in vec2 a_unitPos;

// Instanced attributes (divisor = 1)
layout(location = 1) in vec2 a_startMm;      // (x0, y0) on peg A in physical mm
layout(location = 2) in vec2 a_endMm;        // (x1, y1) on peg B in physical mm
layout(location = 3) in vec4 a_color;        // Linear RGB (r, g, b) + base opacity (a)
layout(location = 4) in float a_thicknessMm; // Physical thread thickness in mm

uniform float u_extentMm;                    // Side length of square loom bounding frame in mm
uniform float u_aaPaddingMm;                 // Antialiasing expansion margin in mm

out float v_distAcross;                      // Normalized distance across thread in [-1.0, 1.0]
out vec4 v_color;                            // Thread color in Linear RGB + opacity
out vec2 v_tangent;                          // Normalized travel tangent vector
out float v_energyScale;                     // Sub-pixel optical energy conservation factor

void main() {
    vec2 delta = a_endMm - a_startMm;
    float len = length(delta);
    vec2 dir = len > 1e-6 ? delta / len : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);

    // Half thickness expanded by antialiasing feather margin
    float halfWidth = (a_thicknessMm * 0.5) + u_aaPaddingMm;

    // Local vertex coordinate in physical loom space (mm)
    vec2 posMm = a_startMm + a_unitPos.x * delta + a_unitPos.y * halfWidth * normal;

    // Convert from mm [0, u_extentMm] to WebGL NDC [-1.0, 1.0], flipping Y for screen orientation
    vec2 ndc = (posMm / u_extentMm) * 2.0 - 1.0;
    ndc.y = -ndc.y;

    gl_Position = vec4(ndc, 0.0, 1.0);

    v_distAcross = a_unitPos.y;
    v_color = a_color;
    v_tangent = dir;
    v_energyScale = clamp(a_thicknessMm / max(1.36 * halfWidth, 1e-4), 0.05, 1.0);
}
`;

export const ACCUMULATION_FS = `#version 300 es
precision highp float;

in float v_distAcross;
in vec4 v_color;
in vec2 v_tangent;
in float v_energyScale;

out vec4 fragColor;

uniform float u_aaRamp; // Edge feather ramp width (e.g. 0.35)

void main() {
    float dist = abs(v_distAcross);
    if (dist > 1.0) {
        discard;
    }

    // Cylindrical section optical transmittance:
    // Physical chord through a cylinder of radius R has length proportional to sqrt(1 - (d/R)^2)
    float cylinder = sqrt(max(0.0, 1.0 - dist * dist));

    // Analytical edge antialiasing
    float edgeAlpha = 1.0 - smoothstep(1.0 - u_aaRamp, 1.0, dist);

    // Final linear alpha attenuation with sub-pixel optical energy conservation
    float alpha = clamp(v_color.a * v_energyScale * cylinder * edgeAlpha, 0.0, 1.0);

    // Output in Linear RGB with alpha for Porter-Duff GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA
    fragColor = vec4(v_color.rgb, alpha);
}
`;

export const SCREEN_VS = `#version 300 es
precision highp float;

// Fullscreen quad in NDC [-1.0, 1.0]
layout(location = 0) in vec2 a_pos;

out vec2 v_uv;

void main() {
    v_uv = a_pos * 0.5 + 0.5; // [0.0, 1.0]
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const SCREEN_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_accumTexture;
uniform float u_zoom;
uniform vec2 u_pan;
uniform float u_aspect;
uniform float u_loomRadius;     // Normalized radius of physical loom circle (e.g. 0.46)
uniform float u_rimWidth;       // Outer rim frame width (e.g. 0.035)
uniform int u_pinCount;         // Number of perimeter pins N
uniform float u_pinRadius;      // Normalized physical pin radius
uniform bool u_showFrame;       // Toggle for wood/aluminum rim rendering
uniform bool u_showPins;        // Toggle for metallic pin rendering
uniform vec3 u_backgroundColor; // Background color in Linear RGB

// Standard piecewise IEC 61966-2-1 tone mapping: Linear RGB to sRGB
vec3 linearToSrgb(vec3 c) {
    vec3 low = c * 12.92;
    vec3 high = 1.055 * pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(0.0031308, c));
}

void main() {
    // Zoom and pan centered on viewport (0.5, 0.5)
    vec2 centered = v_uv - 0.5;
    if (u_aspect > 1.0) {
        centered.x *= u_aspect;
    } else if (u_aspect < 1.0) {
        centered.y /= u_aspect;
    }

    vec2 simCoord = (centered / u_zoom) + 0.5 - u_pan;

    // Check bounds of accumulation texture
    bool inTex = simCoord.x >= 0.0 && simCoord.x <= 1.0 && simCoord.y >= 0.0 && simCoord.y <= 1.0;

    // Polar coordinates relative to loom center
    vec2 p = simCoord - 0.5;
    float r = length(p);

    // Read accumulated Linear RGB transmittance from FBO texture
    vec4 accum = inTex
        ? texture(u_accumTexture, vec2(simCoord.x, 1.0 - simCoord.y))
        : vec4(u_backgroundColor, 1.0);

    // 1. Subtle Directional Fiber Shading (high-pass gradient relief along weave)
    vec2 texel = 1.0 / vec2(textureSize(u_accumTexture, 0));
    float lumC = dot(accum.rgb, vec3(0.2126, 0.7152, 0.0722));
    float lumR = dot(texture(u_accumTexture, vec2(simCoord.x + texel.x, 1.0 - simCoord.y)).rgb, vec3(0.2126, 0.7152, 0.0722));
    float lumU = dot(texture(u_accumTexture, vec2(simCoord.x, 1.0 - (simCoord.y + texel.y))).rgb, vec3(0.2126, 0.7152, 0.0722));
    vec2 fiberGrad = vec2(lumR - lumC, lumU - lumC);

    vec2 lightDir2D = normalize(vec2(-0.6, 0.8));
    float sheen = clamp(dot(fiberGrad, lightDir2D) * 1.2, -0.05, 0.05);

    vec3 linearColor = clamp(accum.rgb + sheen, 0.0, 1.0);

    // Inner rim vignette / soft contact shadow
    float innerShadow = smoothstep(u_loomRadius, u_loomRadius - 0.02, r);
    linearColor = mix(linearColor * 0.78, linearColor, innerShadow);

    // Convert Linear RGB to perceptual sRGB for display
    vec3 finalColor = linearToSrgb(linearColor);

    // 2. Physical Outer Rim & Metallic Hoop
    if (u_showFrame) {
        float rOuter = u_loomRadius + u_rimWidth;
        if (r >= u_loomRadius && r < rOuter) {
            float angle = atan(p.y, p.x);
            float brush = 0.03 * sin(angle * 80.0) + 0.02 * cos(angle * 4.0);
            float rimGrad = smoothstep(u_loomRadius, rOuter, r);
            vec3 rimBase = mix(vec3(0.20, 0.19, 0.18), vec3(0.12, 0.12, 0.11), rimGrad);

            // Inner and outer bevel highlights
            float bevelInner = smoothstep(u_loomRadius, u_loomRadius + 0.003, r);
            float bevelOuter = smoothstep(rOuter, rOuter - 0.003, r);
            finalColor = (rimBase + brush) * bevelInner * bevelOuter + vec3(0.14) * (1.0 - bevelOuter);
        } else if (r >= rOuter) {
            // Dark neutral studio backdrop
            finalColor = vec3(0.08, 0.08, 0.075);
        }
    }

    // 3. Metallic Pegs (0 rad at +X, counterclockwise in loom coordinates)
    if (u_showPins && u_pinCount > 0 && r < u_loomRadius + u_rimWidth + 0.02) {
        float twoPi = 6.283185307179586;
        float angleStep = twoPi / float(u_pinCount);
        float phi = atan(p.y, p.x);
        if (phi < 0.0) phi += twoPi;

        float pinIndex = floor(phi / angleStep + 0.5);
        float pinAngle = pinIndex * angleStep;
        vec2 pinCenter = u_loomRadius * vec2(cos(pinAngle), sin(pinAngle));
        float distToPin = length(p - pinCenter);

        // Soft contact drop shadow
        vec2 shadowOffset = -0.003 * normalize(vec2(-0.5, 0.7));
        float shadowDist = length(p - (pinCenter + shadowOffset));
        float pinShadow = smoothstep(u_pinRadius, u_pinRadius + 0.004, shadowDist);
        finalColor *= mix(0.55, 1.0, pinShadow);

        // Metallic cylinder lighting
        if (distToPin <= u_pinRadius) {
            vec2 pinNorm2D = (p - pinCenter) / u_pinRadius;
            float nz = sqrt(max(0.0, 1.0 - dot(pinNorm2D, pinNorm2D)));
            vec3 pinNorm = normalize(vec3(pinNorm2D.x, pinNorm2D.y, nz));

            vec3 light3D = normalize(vec3(-0.4, 0.6, 0.8));
            float diff = max(0.0, dot(pinNorm, light3D));
            vec3 view3D = vec3(0.0, 0.0, 1.0);
            vec3 halfVec = normalize(light3D + view3D);
            float spec = pow(max(0.0, dot(pinNorm, halfVec)), 32.0);

            vec3 pinColor = vec3(0.72, 0.74, 0.78) * (0.35 + 0.65 * diff) + vec3(0.95) * spec;
            float pinAA = 1.0 - smoothstep(u_pinRadius - 0.0008, u_pinRadius, distToPin);
            finalColor = mix(finalColor, pinColor, pinAA);
        }
    }

    fragColor = vec4(finalColor, 1.0);
}
`;

/** Compiles a GLSL shader and checks compilation status. */
export function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create WebGL shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation error: ${info}`);
  }
  return shader;
}

/** Links vertex and fragment shaders into a WebGLProgram. */
export function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Failed to create WebGL program');
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  // Mark shaders for deletion once program is linked
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link error: ${info}`);
  }
  return program;
}
