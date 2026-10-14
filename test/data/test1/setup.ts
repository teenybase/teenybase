import {config, migrations} from './generated.json'
import {applyMigrations} from '../apply-migrations'

// to regenerate config, see ../../generateMigrations.test.ts
export async function setup(){
    await applyMigrations([...migrations, {
        name: '20000_Fill_Dummy_Data.sql',
        sql: dummyData
    }])
    return structuredClone(config)
}

export const dummyData = `
INSERT INTO users (name, email, uid, pass_hash) VALUES
('John Doe', 'john@example.com', 'john123', 'hash1'),
('Jane Smith', 'jane@example.com', 'jane456', 'hash2'),
('Bob Johnson', 'bob@example.com', 'bob789', 'hash3'),
('Alice Brown', 'alice@example.com', 'alice101', 'hash4'),
('Charlie Davis', 'charlie@example.com', 'charlie202', 'hash5'),
('Eva Wilson', 'eva@example.com', 'eva303', 'hash6'),
('Frank Miller', 'frank@example.com', 'frank404', 'hash7'),
('Grace Lee', 'grace@example.com', 'grace505', 'hash8'),
('Henry Taylor', 'henry@example.com', 'henry606', 'hash9'),
('Ivy Clark', 'ivy@example.com', 'ivy707', 'hash10');

INSERT INTO files (name, url, metadata, user_id) VALUES
('document1.pdf', 'http://example.com/doc1.pdf', '{"size": "1.2MB", "type": "PDF"}', 1),
('image1.jpg', 'http://example.com/img1.jpg', '{"size": "500KB", "resolution": "1920x1080"}', 2),
('spreadsheet1.xlsx', 'http://example.com/sheet1.xlsx', '{"size": "750KB", "sheets": 3}', 3),
('presentation1.pptx', 'http://example.com/pres1.pptx', '{"size": "2.1MB", "slides": 15}', 4),
('video1.mp4', 'http://example.com/vid1.mp4', '{"size": "50MB", "duration": "00:05:30"}', 5),
('document2.docx', 'http://example.com/doc2.docx', '{"size": "800KB", "pages": 10}', 6),
('image2.png', 'http://example.com/img2.png', '{"size": "1.5MB", "resolution": "3840x2160"}', 7),
('audio1.mp3', 'http://example.com/audio1.mp3', '{"size": "5MB", "duration": "00:03:45"}', 8),
('code1.py', 'http://example.com/code1.py', '{"size": "10KB", "lines": 150}', 9),
('archive1.zip', 'http://example.com/archive1.zip', '{"size": "100MB", "files": 50}', 10);
`
