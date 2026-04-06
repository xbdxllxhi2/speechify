import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MiniPlayerComponent } from './shared/components/mini-player/mini-player.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MiniPlayerComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
