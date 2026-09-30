import type { SceneDocument } from "../../src/core/documents";

/** Public scene placeables; tags select them together without touching assets/actors. */
export function environmentPlaceables(): Pick<SceneDocument, "lights" | "sounds" | "templates"> {
  const common = { ownership: { default: 1 as const }, flags: {}, system: {}, taggerTags: ["cleanup"], x: 300, y: 300 };
  return {
    lights: [{...common,_id:"environment-light",type:"light",name:"Torch",color:"#ffffff",alpha:0.8,bright:100,dim:200}],
    sounds: [{...common,_id:"environment-sound",type:"sound",name:"Fountain",audio:"a".repeat(64),radius:200,volume:0.5,loop:true}],
    templates: [{...common,_id:"environment-template",type:"template",name:"Ward",kind:"circle",distance:20,direction:0,width:5}],
  };
}
