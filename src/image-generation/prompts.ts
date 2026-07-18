import type { Gender } from './types';

const STUDIO_REQUIREMENTS = `Full body, full-length photorealistic studio portrait of the person from the attached photo, identity and facial features preserved, apparent age preserved exactly, do not make the person look older, no aging effect, head to heels fully visible, no cropping. Vertical 9:16 fashion catalog composition where the adult body fills most of the frame height: shoes/feet start very close to the bottom edge with only 2-4% margin, and the top of the head is in the upper area with only 4-7% margin. Avoid tiny full-body framing and avoid large empty white space above, below, or around the person. Camera is farther away with a 90-135mm portrait lens look, straight-on with the camera centered on the middle of the body/torso, not at head level, sensor perfectly vertical and parallel to the person, no downward tilt. Preserve realistic adult anatomy: normal head size, long natural adult legs, hips/knees/ankles correctly placed, legs about half of total body height, full-length fashion proportions. Perfect seamless white cyclorama background. The subject stands about 40 cm in front of the white back wall, with a clear soft shadow cast behind the subject and slightly lower on the white wall and floor. Clean studio lighting, natural skin texture, sharp details, 1536x2752 pixels resolution.`;

const NEGATIVE_PROMPT = `Negative prompt: older-looking person, aged face, aging effect, elderly, senior, extra wrinkles, gray hair unless present in the original photo, close-up, half body, tiny person in frame, excessive empty space, cropped head, cropped feet, short legs, foreshortened legs, squat body, oversized head, childlike proportions, chibi proportions, head-level camera, downward camera tilt, low angle, high angle, wide-angle distortion, colored background, dark background, outdoor background, clutter, extra people, duplicate person, distorted face, bad anatomy, unreadable face.`;

const ATMOSPHERE_BADGE = 'Главный по атмосфере';
const DEADLINE_MASTER = 'Магистр дедлайнов';
const HAPPINESS_GRADUATE = 'Выпускник отдела счастья';

const UNIVERSAL_PROMPTS: string[] = [
  `${STUDIO_REQUIREMENTS} Corporate hipster dacha enthusiast. The subject wears a stylish plaid shirt, fashionable glasses, relaxed smart-casual styling. They hold a woven wicker basket filled with fresh strawberries in one hand and a watering can in the other. Around their neck is an event badge with clearly readable Russian text: "${ATMOSPHERE_BADGE}". The vibe is light, informal, caring about culture and team atmosphere. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Cyber graduate 2026. The subject wears a classic academic graduation gown, but the edges of the gown have elegant neon glowing inserts. Futuristic glasses on the face. They hold a diploma in a holographic cover, premium futuristic university style. The vibe is youth, technology, progress, optimistic future. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Retro 1990s office character. The subject wears an oversized tie with an absurd funny print, a sweater over a shirt, and massive old-fashioned "grandma" glasses. In front of them, held proudly or resting against the body, is a bulky suitcase-like vintage laptop. On the laptop screen there is a clearly visible retro arcade maze game inspired by Pac-Man: black screen, blue maze lines, small yellow circular hero, colorful ghost-like enemies, pixel-art style. The vibe is nostalgia, self-irony, warm retro office humor. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Professional skill set: IT. The subject looks like a confident relaxed IT professional. A full-size keyboard hangs over their shoulder like a casual work accessory. In their hands is a large coffee mug with clearly readable text: "Code & Chill". The vibe is expertise, calm confidence, relaxed technical mastery. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Professional skill set: HR. The subject wears elegant modern business styling with trousers or a structured suit. In one hand they hold a neat stack of colorful "happiness cards"; in the other hand they hold a solid official stamp with clearly readable text: "Approved". The vibe is empathy, decision-making, professional confidence, human-centered expertise. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Outdoor team member. The subject wears high-quality hiking sportswear: a technical membrane jacket, outdoor pants, sturdy trekking shoes, and a cap. They hold a thermo mug confidently and have a pair of trekking poles / hiking sticks clearly visible in their hands or attached to their backpack. The vibe is one team moving toward the summit, reliable, energetic, outdoors-ready. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Padel player at an HR forum sports networking event. The subject wears stylish modern padel sportswear: athletic polo or performance top, sport shorts or athletic trousers, clean court sneakers, wristband. They hold a padel racket in one hand and a bright padel ball in the other hand, both clearly visible. Confident friendly expression, energetic but controlled full-body pose, premium sporty corporate vibe. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Ambitious university reunion professional, premium stylized 3D character render with smooth Pixar-like textures while preserving the real face from the attached photo. The subject wears academic regalia: a graduation gown and a mortarboard hat with a tassel. Around their neck is a sash with clearly readable text: "CEO 2026". In their hands they hold a stack of professional charts and growth graphs arranged like a diploma. Vibrant colors, expressive confident smile, cinematic but clean studio composition. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Funny professional contrast: punk manager, premium stylized 3D character render with smooth Pixar-like textures while preserving the real face from the attached photo. The subject has a stylish mohawk haircut with punk energy, but wears a sharp tailored corporate business suit and tie. They hold a professional microphone in one hand. Expressive facial features, energetic full-body pose, vivid colors. No dress, no skirt, no moustache. ${NEGATIVE_PROMPT}`,
];

const MALE_ONLY_PROMPTS: string[] = [
  `${STUDIO_REQUIREMENTS} Outdoor team member. He wears high-quality hiking sportswear: a technical membrane jacket, outdoor pants, sturdy trekking shoes, and a cap. He has a neat stylish moustache. He holds a thermo mug confidently and has a pair of trekking poles / hiking sticks clearly visible in his hands or attached to his backpack. The vibe is one team moving toward the summit, reliable, energetic, outdoors-ready. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Funny professional contrast: punk manager, premium stylized 3D character render with smooth Pixar-like textures while preserving the real face from the attached photo. He has a stylish mohawk haircut with punk energy, but wears a sharp tailored corporate business suit and tie. He holds a professional microphone in one hand and has a goofy confident mustache. Expressive facial features, energetic full-body pose, vivid colors. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Master of deadlines. Strict full-length composition: the entire body must be visible from the top of the head to the shoes, including both feet and floor contact, with feet placed just above the lower frame edge and the head placed in the upper frame area. Do not make the person small, do not add extra blank space, do not make a waist-up portrait, do not crop the robe or feet. He has a serious scholar-like presence, wearing an academic gown embroidered with clearly readable Russian text: "${DEADLINE_MASTER}". He holds an hourglass in his hands at chest or waist level without covering the full body silhouette. The vibe is drive, responsibility, focus, victory over time. ${NEGATIVE_PROMPT}`,
];

const FEMALE_ONLY_PROMPTS: string[] = [
  `${STUDIO_REQUIREMENTS} Community Laboratory curator for an HR forum, a distinctly feminine elegant look. She wears a refined white lab-coat-inspired blazer dress over a business outfit, tasteful heels, and a delicate badge reading "Community Lab". In her hands she holds transparent cards with glowing connection lines between people icons. The vibe is smart, warm, community-building, modern HR leadership. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Chief of emotional climate at the HR forum "Community Laboratory". She wears a sophisticated feminine business dress with a structured blazer, soft pastel accents, and elegant accessories. She holds a glass terrarium-like sphere with miniature glowing community nodes inside. The vibe is empathy, culture care, premium corporate femininity. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Community architect, HR forum heroine. She wears a stylish satin blouse, tailored high-waist trousers, and an elegant long vest, clearly feminine styling. Around her are subtle floating sticky notes and tiny glowing chat bubbles forming a clean network map. In her hands she holds a tablet with a simple community dashboard. The vibe is facilitation, connection, strategic warmth. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Happiness department graduate, distinctly feminine festive version. She wears a tasteful elegant dress under a graduation gown, a sash across the shoulder with clearly readable Russian text: "${HAPPINESS_GRADUATE}", and holds a bright helium balloon. The vibe is joy, celebration, HR energy, friendly triumph. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Community Lab mentor, premium feminine 3D character render with smooth Pixar-like textures while preserving the real face from the attached photo. She wears a modern elegant jumpsuit with a light cropped blazer, statement earrings, and a badge reading "HR Forum". She holds a microphone and a stack of colorful workshop cards. The vibe is confident, inspiring, welcoming, expert in community facilitation. ${NEGATIVE_PROMPT}`,

  `${STUDIO_REQUIREMENTS} Cyber graduate 2026, distinctly feminine version. She wears a classic academic graduation gown with elegant neon glowing inserts, a mortarboard hat, and futuristic glasses. Under the gown is a tasteful feminine outfit, not revealing. She holds a diploma in a holographic cover. The vibe is youth, technology, progress, optimistic future. ${NEGATIVE_PROMPT}`,
];

export function getRandomPrompt(gender: Gender | null | undefined): string {
  const pool = getAllPromptsForGender(gender);
  return pool[Math.floor(Math.random() * pool.length)];
}

export function getAllPromptsForGender(gender: Gender | null | undefined): string[] {
  if (gender === 'female') return [...UNIVERSAL_PROMPTS, ...FEMALE_ONLY_PROMPTS];
  if (gender === 'male') return [...UNIVERSAL_PROMPTS, ...MALE_ONLY_PROMPTS];
  return [...UNIVERSAL_PROMPTS];
}
